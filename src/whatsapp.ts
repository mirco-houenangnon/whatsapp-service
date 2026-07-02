/**
 * WhatsAppManager — Gestionnaire de connexion Baileys
 *
 * Corrections apportées :
 *  - Backoff exponentiel sur les reconnexions (évite le flood vers WhatsApp)
 *  - Guard isInitializing pour éviter la double initialisation (race condition)
 *  - Nettoyage de l'ancien socket avant d'en créer un nouveau (évite les fuites)
 *  - setMaxListeners(50) pour prévenir les avertissements Node.js
 */

import makeWASocket, {
    DisconnectReason,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    type WASocket,
} from '@whiskeysockets/baileys'
import { Boom }         from '@hapi/boom'
import pino             from 'pino'
import path             from 'path'
import { EventEmitter } from 'events'
import fs               from 'fs'

const logger = pino({ level: 'silent' })

// Délais de reconnexion : 1s, 2s, 4s, 8s, 16s, 30s max
const RECONNECT_DELAYS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000]

export class WhatsAppManager extends EventEmitter {
    private sock: WASocket | null = null
    private sessionId: string
    private authPath: string
    private isConnected: boolean = false
    private isInitializing: boolean = false   // guard contre la double init
    private reconnectAttempt: number = 0      // compteur pour le backoff

    constructor(sessionId: string = 'primary-session') {
        super()

        // On accepte jusqu'à 50 écouteurs (un par client Socket.io connecté)
        // avant que Node.js n'affiche un avertissement de fuite mémoire
        this.setMaxListeners(50)

        this.sessionId = sessionId
        this.authPath  = path.join(process.cwd(), 'auth', this.sessionId)

        // Créer le dossier auth/ s'il n'existe pas
        const authRoot = path.join(process.cwd(), 'auth')
        if (!fs.existsSync(authRoot)) {
            fs.mkdirSync(authRoot, { recursive: true })
        }
    }

    // ─── Initialisation ───────────────────────────────────────────────────────

    async init(): Promise<void> {
        // Guard : si une initialisation est déjà en cours, ne pas en lancer une deuxième
        // Corrige la race condition entre logout() et connection.update('close')
        if (this.isInitializing) {
            console.log('[Baileys] Initialisation déjà en cours — ignoré')
            return
        }

        this.isInitializing = true

        try {
            // Fermer proprement l'ancien socket s'il existe
            // Évite d'accumuler des WebSockets ouverts en mémoire
            if (this.sock) {
                this._closeSocket(this.sock)
                this.sock = null
            }

            const { state, saveCreds } = await useMultiFileAuthState(this.authPath)
            const { version }          = await fetchLatestBaileysVersion()

            console.log(`[Baileys] Version : ${version.join('.')}`)

            this.sock = makeWASocket({
                version,
                logger,
                auth: state,
                // Ne pas synchroniser l'historique complet — réduit la charge mémoire
                syncFullHistory: false,
            })

            // ── Événements de connexion ────────────────────────────────────────
            this.sock.ev.on('connection.update', (update) => {
                const { connection, lastDisconnect, qr } = update

                if (qr) {
                    this.isConnected = false
                    this.emit('qr', qr)
                }

                if (connection === 'close') {
                    this.isConnected = false
                    const statusCode      = (lastDisconnect?.error as Boom)?.output?.statusCode
                    const shouldReconnect = statusCode !== DisconnectReason.loggedOut

                    console.log(
                        `[Baileys] Connexion fermée — code: ${statusCode ?? 'inconnu'}` +
                        ` | reconnexion: ${shouldReconnect}`
                    )

                    if (shouldReconnect) {
                        // Backoff exponentiel : attend avant de retenter
                        const delay = RECONNECT_DELAYS[
                            Math.min(this.reconnectAttempt, RECONNECT_DELAYS.length - 1)
                        ] ?? 30_000
                        this.reconnectAttempt++
                        console.log(`[Baileys] Tentative #${this.reconnectAttempt} dans ${delay / 1000}s...`)
                        setTimeout(() => this.init(), delay)
                    } else {
                        // Session révoquée côté WhatsApp → reset complet
                        console.log('[Baileys] Session révoquée — nettoyage et nouveau QR')
                        this.sock = null
                        this._deleteSession()
                        this.emit('logged_out')
                        // Délai court avant de relancer pour éviter un double appel
                        setTimeout(() => this.init(), 500)
                    }

                } else if (connection === 'open') {
                    this.isConnected    = true
                    this.reconnectAttempt = 0  // reset du compteur de backoff
                    console.log('[Baileys] Connexion ouverte — WhatsApp connecté ✅')
                    this.emit('ready')
                }
            })

            this.sock.ev.on('creds.update', saveCreds)

            this.sock.ev.on('messages.upsert', (m) => {
                // N'émet que les messages entrants réels (pas les historiques)
                if (m.type === 'notify') {
                    this.emit('message', m)
                }
            })

        } catch (err) {
            console.error('[Baileys] Erreur lors de l\'initialisation :', err)
            // Retry avec backoff si l'init elle-même échoue (ex: réseau absent)
            const delay = RECONNECT_DELAYS[
                Math.min(this.reconnectAttempt, RECONNECT_DELAYS.length - 1)
            ] ?? 30_000
            this.reconnectAttempt++
            console.log(`[Baileys] Réessai de l'init dans ${delay / 1000}s...`)
            setTimeout(() => this.init(), delay)
        } finally {
            // Le guard doit être levé dans tous les cas
            this.isInitializing = false
        }
    }

    // ─── Déconnexion ──────────────────────────────────────────────────────────

    async logout(): Promise<void> {
        this.isConnected = false

        if (this.sock) {
            try {
                await this.sock.logout()
            } catch {
                // Session déjà invalide ou réseau coupé — on nettoie quand même
            }
            this._closeSocket(this.sock)
            this.sock = null
        }

        this._deleteSession()
        this.emit('logged_out')

        // Petit délai pour éviter la race condition avec connection.update('close')
        // qui peut aussi appeler init() quasi-simultanément
        setTimeout(() => this.init(), 500)
    }

    // ─── Envoi de message ─────────────────────────────────────────────────────

    /**
     * Envoie un message texte WhatsApp.
     * Lance une erreur si le socket n'est pas prêt ou si le timeout est dépassé.
     *
     * @param remoteJid  JID WhatsApp (ex: 22997123456@s.whatsapp.net)
     * @param text       Texte (supporte *gras*, _italique_, ~barré~)
     * @param timeoutMs  Délai max en ms (défaut : 15 000)
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
            throw new Error('WhatsApp non connecté — scannez le QR code')
        }

        const send = this.sock.sendMessage(remoteJid, { text })

        const timeout = new Promise<never>((_, reject) =>
            setTimeout(
                () => reject(new Error(`Timeout : pas de réponse après ${timeoutMs}ms`)),
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

    // ─── Utilitaire privé ─────────────────────────────────────────────────────

    /**
     * Ferme proprement un socket Baileys.
     * Retire tous les écouteurs event par event (removeAllListeners de Baileys
     * n'accepte pas d'appel sans argument) puis ferme la connexion WebSocket.
     */
    private _closeSocket(sock: WASocket): void {
        // Liste exhaustive des events Baileys — on les retire tous
        const events = [
            'connection.update',
            'creds.update',
            'messaging-history.set',
            'messaging-history.status',
            'chats.upsert',
            'chats.update',
            'chats.delete',
            'chats.lock',
            'lid-mapping.update',
            'presence.update',
            'contacts.upsert',
            'contacts.update',
            'messages.delete',
            'messages.update',
            'messages.media-update',
            'messages.upsert',
            'messages.reaction',
            'message-receipt.update',
            'message-capping.update',
            'groups.upsert',
            'groups.update',
            'group-participants.update',
            'group.join-request',
            'group.member-tag.update',
            'blocklist.set',
            'blocklist.update',
            'call',
            'labels.edit',
            'labels.association',
            'newsletter.reaction',
            'newsletter.view',
            'newsletter-participants.update',
            'newsletter-settings.update',
            'settings.update',
        ] as const

        for (const event of events) {
            try { sock.ev.removeAllListeners(event) } catch { /* ignoré */ }
        }

        try { sock.end(undefined) } catch { /* déjà fermé */ }
    }

    private _deleteSession(): void {
        try {
            if (fs.existsSync(this.authPath)) {
                fs.rmSync(this.authPath, { recursive: true, force: true })
                console.log('[Baileys] Session locale supprimée')
            }
        } catch (err) {
            console.error('[Baileys] Impossible de supprimer la session :', err)
        }
    }
}
