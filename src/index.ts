/**
 * WhatsApp Bridge — Serveur Express + Socket.io
 *
 * Expose :
 *   POST /send-message  → envoyer un message WhatsApp
 *   GET  /status        → état de la connexion
 *   DELETE /logout      → déconnecter et réinitialiser la session
 *
 * Socket.io :
 *   qr            → image base64 du QR code (client doit la scanner)
 *   ready         → connexion établie
 *   logged_out    → session expirée
 *   status_update → état courant de la connexion
 *   new_message   → message WhatsApp entrant reçu
 *
 * Utilisé par backend-modules via WhatsAppBridgeClient (POST /send-message).
 * Configurable via .env :
 *   PORT=3005
 *   CORS_ORIGIN=*  (local) ou https://mon-domaine.com (production)
 */

import express      from 'express'
import { createServer } from 'http'
import { Server }   from 'socket.io'
import cors         from 'cors'
import dotenv       from 'dotenv'
import qrcode       from 'qrcode'
import { WhatsAppManager } from './whatsapp.js'

dotenv.config()

// ─── Configuration ────────────────────────────────────────────────────────────

const PORT        = Number(process.env['PORT'] ?? 3005)
const CORS_ORIGIN = process.env['CORS_ORIGIN'] ?? '*'
const IS_PROD     = process.env['NODE_ENV'] === 'production'

// ─── Serveur Express + Socket.io ─────────────────────────────────────────────

const app        = express()
const httpServer = createServer(app)
const io         = new Server(httpServer, {
    cors: { origin: CORS_ORIGIN },
})

app.use(cors({ origin: CORS_ORIGIN }))
app.use(express.json())
app.use(express.static('public'))

// ─── WhatsApp Manager ─────────────────────────────────────────────────────────

const waManager = new WhatsAppManager()

// ─── REST : POST /send-message ────────────────────────────────────────────────

app.post('/send-message', async (req, res) => {
    const { to, text } = req.body as { to?: string; text?: string }

    if (!to || !text) {
        res.status(400).json({ success: false, error: 'Paramètres manquants : to et text sont requis' })
        return
    }

    console.log(`[Bridge] Envoi vers : ${to}`)

    try {
        // Nettoyage du numéro
        const cleanTo = to.replace(/[+\s]/g, '').trim()
        const jid     = cleanTo.includes('@s.whatsapp.net')
            ? cleanTo
            : `${cleanTo}@s.whatsapp.net`

        const sock = waManager.getSocket()
        if (!sock) {
            res.status(503).json({ success: false, error: 'Socket WhatsApp non initialisé' })
            return
        }

        // Vérifier si le numéro est sur WhatsApp
        const [result] = await sock.onWhatsApp(jid)

        // ── Fallback numéros béninois ────────────────────────────────────────
        if (!result?.exists) {
            console.log(`[Bridge] Numéro non trouvé : ${jid} — tentative fallback`)

            // Nouveau format béninois (22901XXXXXXXX) → ancien (229XXXXXXXX)
            if (cleanTo.startsWith('22901') && cleanTo.length === 13) {
                const fallbackJid = `229${cleanTo.substring(5)}@s.whatsapp.net`
                const [fb]        = await sock.onWhatsApp(fallbackJid)
                if (fb?.exists) {
                    console.log(`[Bridge] Fallback ancien format OK : ${fallbackJid}`)
                    await waManager.sendMessage(fb.jid, text)
                    res.json({ success: true, message: 'Envoyé (ancien format béninois)' })
                    return
                }
            }

            // Ancien format béninois (229XXXXXXXX) → nouveau (22901XXXXXXXX)
            if (cleanTo.startsWith('229') && !cleanTo.startsWith('22901') && cleanTo.length === 11) {
                const fallbackJid = `22901${cleanTo.substring(3)}@s.whatsapp.net`
                const [fb]        = await sock.onWhatsApp(fallbackJid)
                if (fb?.exists) {
                    console.log(`[Bridge] Fallback nouveau format OK : ${fallbackJid}`)
                    await waManager.sendMessage(fb.jid, text)
                    res.json({ success: true, message: 'Envoyé (nouveau format béninois)' })
                    return
                }
            }

            res.status(400).json({ success: false, error: 'Numéro non enregistré sur WhatsApp' })
            return
        }

        await waManager.sendMessage(result.jid, text)
        res.json({ success: true, message: 'Message envoyé' })

    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error)
        console.error('[Bridge] Erreur envoi :', message)
        res.status(500).json({ success: false, error: message })
    }
})

// ─── REST : GET /status ───────────────────────────────────────────────────────

app.get('/status', (_req, res) => {
    res.json(waManager.getStatus())
})

// ─── REST : DELETE /logout ────────────────────────────────────────────────────

app.delete('/logout', async (_req, res) => {
    try {
        await waManager.logout()
        res.json({ success: true, message: 'Session supprimée — QR code requis au prochain démarrage' })
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error)
        res.status(500).json({ success: false, error: message })
    }
})

// ─── Socket.io ────────────────────────────────────────────────────────────────

io.on('connection', (socket) => {
    console.log('[Socket.io] Client connecté')

    // Envoyer l'état immédiatement à la connexion
    socket.emit('status_update', waManager.getStatus())

    waManager.on('qr', async (qr: string) => {
        try {
            const qrImage = await qrcode.toDataURL(qr)
            socket.emit('qr', qrImage)
        } catch (e) {
            console.error('[Socket.io] Erreur génération QR :', e)
        }
    })

    waManager.on('ready', () => {
        const status = waManager.getStatus()
        socket.emit('ready', status)
        io.emit('status_update', status)
    })

    waManager.on('logged_out', () => {
        const status = waManager.getStatus()
        io.emit('status_update', status)
        io.emit('logged_out', {})
    })

    waManager.on('message', (m: unknown) => {
        socket.emit('new_message', m)
    })
})

// ─── Démarrage ────────────────────────────────────────────────────────────────

httpServer.listen(PORT, '127.0.0.1', async () => {
    console.log('')
    console.log('╔══════════════════════════════════════════════════╗')
    console.log(`║  WhatsApp Bridge   http://127.0.0.1:${PORT}         ║`)
    console.log(`║  Environnement : ${IS_PROD ? 'production' : 'local       '}               ║`)
    console.log(`║  Baileys source : local (../Baileys)             ║`)
    console.log('╚══════════════════════════════════════════════════╝')
    console.log('')
    await waManager.init()
})
