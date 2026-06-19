/**
 * WhatsAppManager — Gestionnaire de connexion Baileys
 *
 * Utilise Baileys LOCAL (../Baileys) pour la connexion WhatsApp Web.
 * Expose un EventEmitter pour : qr, ready, logged_out, message.
 * Gère automatiquement la reconnexion sauf en cas de déconnexion explicite.
 */

import makeWASocket, {
    DisconnectReason,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    type WASocket,
} from '@whiskeysockets/baileys'
import { Boom } from '@hapi/boom'
import pino from 'pino'
import path from 'path'
import { EventEmitter } from 'events'
import fs from 'fs'

const logger = pino({ level: 'silent' })

export class WhatsAppManager extends EventEmitter {
    private sock: WASocket | null = null
    private sessionId: string
    private authPath: string
    private isConnected: boolean = false

    constructor(sessionId: string = 'primary-session') {
        super()
        this.sessionId = sessionId
        this.authPath  = path.join(process.cwd(), 'auth', this.sessionId)

        if (!fs.existsSync(path.join(process.cwd(), 'auth'))) {
            fs.mkdirSync(path.join(process.cwd(), 'auth'), { recursive: true })
        }
    }

    // ─── Initialisation ───────────────────────────────────────────────────────

    async init(): Promise<void> {
        const { state, saveCreds } = await useMultiFileAuthState(this.authPath)
        const { version }          = await fetchLatestBaileysVersion()

        console.log(`[Baileys] Utilisation de la version ${version.join('.')}`)

        this.sock = makeWASocket({
            version,
            logger,
            auth: state,
        })

        // ── Gestion des événements de connexion ───────────────────────────────
        this.sock.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect, qr } = update

            if (qr) {
                this.isConnected = false
                this.emit('qr', qr)
            }

            if (connection === 'close') {
                this.isConnected = false
                const statusCode     = (lastDisconnect?.error as Boom)?.output?.statusCode
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut

                console.log(
                    `[Baileys] Connexion fermée — raison: ${lastDisconnect?.error?.message ?? 'inconnue'}` +
                    ` | reconnexion: ${shouldReconnect}`
                )

                if (shouldReconnect) {
                    this.init()
                } else {
                    console.log('[Baileys] Session expirée — suppression de la session locale')
                    this.sock = null
                    if (fs.existsSync(this.authPath)) {
                        fs.rmSync(this.authPath, { recursive: true, force: true })
                    }
                    this.emit('logged_out')
                    this.init()
                }
            } else if (connection === 'open') {
                this.isConnected = true
                console.log('[Baileys] Connexion ouverte — WhatsApp connecté')
                this.emit('ready')
            }
        })

        this.sock.ev.on('creds.update', saveCreds)

        this.sock.ev.on('messages.upsert', (m) => {
            this.emit('message', m)
        })
    }

    // ─── Déconnexion ──────────────────────────────────────────────────────────

    async logout(): Promise<void> {
        this.isConnected = false
        if (this.sock) {
            try {
                await this.sock.logout()
            } catch {
                // Si logout() échoue (session déjà invalide), on nettoie quand même
            }
        }
        // Supprimer la session locale pour forcer un nouveau QR au prochain démarrage
        if (fs.existsSync(this.authPath)) {
            fs.rmSync(this.authPath, { recursive: true, force: true })
        }
        this.sock = null
        this.emit('logged_out')
        // Redémarrer pour afficher le QR
        this.init()
    }

    // ─── Envoi de message ─────────────────────────────────────────────────────

    /**
     * Envoie un message WhatsApp avec timeout de sécurité.
     * Lance une erreur si le socket n'est pas initialisé ou si WhatsApp
     * n'est pas connecté (QR non scanné).
     *
     * @param remoteJid  JID WhatsApp (ex: 22997123456@s.whatsapp.net)
     * @param text       Texte du message (supporte *gras*, _italique_)
     * @param timeoutMs  Délai max en ms (défaut: 15 000)
     */
    async sendMessage(
        remoteJid: string,
        text: string,
        timeoutMs: number = 15_000
    ): Promise<unknown> {
        if (!this.sock) {
            throw new Error('WhatsApp socket non initialisé')
        }
        if (!this.isConnected) {
            throw new Error('WhatsApp non connecté. Scannez le QR code.')
        }

        const send    = this.sock.sendMessage(remoteJid, { text })
        const timeout = new Promise<never>((_, reject) =>
            setTimeout(
                () => reject(new Error(`sendMessage timeout après ${timeoutMs}ms`)),
                timeoutMs
            )
        )

        return Promise.race([send, timeout])
    }

    // ─── Statut ───────────────────────────────────────────────────────────────

    getStatus(): { status: string; user?: { id: string; name: string } } {
        if (this.isConnected && this.sock?.user) {
            return {
                status: 'connected',
                user: {
                    id:   this.sock.user.id,
                    name: this.sock.user.name ?? '',
                },
            }
        }
        return { status: 'disconnected' }
    }

    getSocket(): WASocket | null {
        return this.sock
    }
}
