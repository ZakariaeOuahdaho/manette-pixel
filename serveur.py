"""Manette Pixel : le téléphone devient une manette Xbox 360 pour ce PC.

Le serveur sert l'interface manette (dossier web/) au téléphone, puis reçoit
par WebSocket l'état complet de la manette (boutons, gâchettes, joysticks) et
l'applique à une manette Xbox 360 virtuelle créée via ViGEmBus (vgamepad).

Choix qui rendent le tout fiable :
- le téléphone envoie toujours l'état COMPLET, jamais des événements
  « appui / relâche » : un message perdu ou en retard ne peut pas laisser un
  bouton coincé, le message suivant corrige tout ;
- un chien de garde remet la manette au neutre si le téléphone se tait plus
  d'une seconde (écran verrouillé, Wi-Fi coupé, onglet en arrière-plan) ;
- une manette virtuelle reste attachée au même téléphone (identifiant stocké
  sur le téléphone) : une reconnexion reprend la même manette au lieu d'en
  brancher une nouvelle, donc le jeu ne voit pas de débranchement.
"""

import argparse
import asyncio
import json
import os
import secrets
import shutil
import socket
import struct
import subprocess
import sys
import time
import webbrowser
from datetime import datetime
from pathlib import Path

from aiohttp import WSMsgType, web

ICI = Path(__file__).resolve().parent
WEB = ICI / "web"
CONFIG = ICI / "config.json"

PORT_DEFAUT = 8765
MAX_MANETTES = 4  # limite de XInput
CHIEN_DE_GARDE_S = 1.0
DELAI_BONJOUR_S = 5.0
DELAI_REPRISE_S = 10.0  # au-delà, la manette d'un téléphone parti peut passer à un autre
DELAI_RETRAIT_S = 120.0  # au-delà, elle est débranchée de Windows

# Message binaire envoyé par le téléphone, 13 octets, petit-boutiste :
# type (1 = état), boutons XUSB, LT, RT, LX, LY, RX, RY.
ETAT = struct.Struct("<BHBBhhhh")
TYPE_ETAT = 1

# Codes de fermeture WebSocket compris par l'interface.
FERMETURE_REMPLACEE = 4000
FERMETURE_JETON = 4001
FERMETURE_COMPLET = 4003
FERMETURE_PROTOCOLE = 4004


def journal(texte):
    print(f"[{datetime.now():%H:%M:%S}] {texte}", flush=True)


try:
    import vgamepad as vg
except Exception as erreur:  # le pilote absent fait échouer l'import lui-même
    print(
        "\nImpossible de joindre le pilote ViGEmBus : "
        f"{erreur}\n"
        "Installe-le depuis https://github.com/nefarius/ViGEmBus/releases "
        "(ViGEmBus_*_x64_x86_arm64.exe), redémarre si demandé, puis relance.\n",
        file=sys.stderr,
    )
    sys.exit(1)


def octet_signe(valeur):
    # vgamepad déclare les gâchettes en c_byte (signé) : 255 doit devenir -1
    # pour que l'octet transmis au pilote soit bien 0xFF.
    return valeur - 256 if valeur > 127 else valeur


class Manette:
    """Une manette Xbox 360 virtuelle, prêtée à un téléphone."""

    def __init__(self, numero, boucle):
        self.numero = numero  # 1..4, ordre de création
        self.boucle = boucle
        self.client_id = None
        self.ws = None
        self.joueur = None  # numéro de joueur attribué par Windows (anneau LED)
        self.vibration = (0, 0)
        self.dernier_message = 0.0
        self.neutre = True
        self.pad = vg.VX360Gamepad()
        self.pad.register_notification(callback_function=self._notification)

    def _notification(self, client, target, gros_moteur, petit_moteur, led, user_data):
        # Appelé depuis un thread du pilote : on repasse sur la boucle asyncio.
        self.boucle.call_soon_threadsafe(self._sur_notification, gros_moteur, petit_moteur, led)

    def _sur_notification(self, gros_moteur, petit_moteur, led):
        joueur = led + 1 if led < 4 else None
        if joueur != self.joueur:
            self.joueur = joueur
            self.envoyer({"t": "joueur", "joueur": joueur})
        if (gros_moteur, petit_moteur) != self.vibration:
            self.vibration = (gros_moteur, petit_moteur)
            self.envoyer({"t": "vibration", "g": gros_moteur, "p": petit_moteur})

    def envoyer(self, message):
        ws = self.ws
        if ws is not None and not ws.closed:
            self.boucle.create_task(self._envoyer(ws, message))

    @staticmethod
    async def _envoyer(ws, message):
        try:
            await ws.send_json(message)
        except (ConnectionError, RuntimeError):
            pass  # la connexion se ferme : son gestionnaire fera le ménage

    def appliquer(self, donnees):
        _, boutons, lt, rt, lx, ly, rx, ry = ETAT.unpack(donnees)
        rapport = self.pad.report
        rapport.wButtons = boutons
        rapport.bLeftTrigger = octet_signe(lt)
        rapport.bRightTrigger = octet_signe(rt)
        rapport.sThumbLX = lx
        rapport.sThumbLY = ly
        rapport.sThumbRX = rx
        rapport.sThumbRY = ry
        self.pad.update()
        self.neutre = not (boutons or lt or rt or lx or ly or rx or ry)

    def neutraliser(self):
        if not self.neutre:
            self.pad.reset()
            self.pad.update()
            self.neutre = True

    def retirer(self):
        """Débranche la manette virtuelle de Windows."""
        # Le rappel ctypes garde une référence vers self : sans casser ce cycle, la
        # manette resterait branchée jusqu'au passage du ramasse-miettes.
        if self.pad.cmp_func is not None:
            self.pad.unregister_notification()
            self.pad.cmp_func = None
        self.pad = None  # vgamepad débranche la manette en libérant l'objet


class Serveur:
    def __init__(self, jeton):
        self.jeton = jeton
        self.manettes = []

    def attribuer(self, client_id, boucle):
        for manette in self.manettes:
            if manette.client_id == client_id:
                return manette
        # Une manette abandonnée reste branchée : la réattribuer avant d'en créer une
        # nouvelle évite qu'un joueur 1 vide passe devant (beaucoup de jeux n'écoutent que lui).
        maintenant = time.monotonic()
        abandonnees = [m for m in self.manettes
                       if m.ws is None and maintenant - m.dernier_message > DELAI_REPRISE_S]
        if abandonnees:
            return min(abandonnees, key=lambda m: m.numero)
        if len(self.manettes) < MAX_MANETTES:
            pris = {m.numero for m in self.manettes}
            numero = min(n for n in range(1, MAX_MANETTES + 1) if n not in pris)
            manette = Manette(numero, boucle)
            self.manettes.append(manette)
            return manette
        # Toutes créées : on reprend celle d'un téléphone parti depuis le plus longtemps.
        libres = [m for m in self.manettes if m.ws is None]
        if libres:
            return min(libres, key=lambda m: m.dernier_message)
        return None

    async def page(self, request):
        return web.FileResponse(WEB / "index.html")

    async def page_qr(self, request):
        # La page QR contient le jeton : seulement pour le PC lui-même.
        if request.remote not in ("127.0.0.1", "::1"):
            raise web.HTTPForbidden()
        return web.Response(text=page_qr(request.app["url"]), content_type="text/html")

    async def websocket(self, request):
        ws = web.WebSocketResponse(heartbeat=4.0, max_msg_size=4096, compress=False)
        await ws.prepare(request)
        activer_nodelay(request)

        # En USB, adb livre la connexion depuis le PC lui-même : pas de code à taper.
        local = request.remote in ("127.0.0.1", "::1")
        origine = "USB" if local else request.remote
        if not local and not secrets.compare_digest(request.query.get("k", ""), self.jeton):
            await ws.close(code=FERMETURE_JETON, message=b"jeton invalide")
            return ws

        client_id = await self._bonjour(ws)
        if client_id is None:
            await ws.close(code=FERMETURE_PROTOCOLE, message=b"bonjour attendu")
            return ws

        boucle = asyncio.get_running_loop()
        manette = self.attribuer(client_id, boucle)
        if manette is None:
            await ws.close(code=FERMETURE_COMPLET, message=b"4 manettes deja prises")
            journal(f"Refusé : déjà {MAX_MANETTES} téléphones connectés ({origine})")
            return ws

        ancienne = manette.ws
        manette.client_id = client_id
        manette.ws = ws
        manette.dernier_message = time.monotonic()
        if ancienne is not None and not ancienne.closed:
            await ancienne.close(code=FERMETURE_REMPLACEE, message=b"remplacee")

        journal(f"Téléphone connecté ({origine}) → manette {manette.numero}")
        await ws.send_json({"t": "bienvenue", "manette": manette.numero, "joueur": manette.joueur})
        if manette.vibration != (0, 0):
            await ws.send_json({"t": "vibration", "g": manette.vibration[0], "p": manette.vibration[1]})

        garde = asyncio.create_task(self._chien_de_garde(manette, ws))
        try:
            async for message in ws:
                manette.dernier_message = time.monotonic()
                if message.type == WSMsgType.BINARY:
                    self._recevoir_etat(manette, message.data)
                elif message.type == WSMsgType.TEXT:
                    await self._recevoir_texte(ws, message.data)
        finally:
            garde.cancel()
            if manette.ws is ws:
                manette.ws = None
                manette.neutraliser()
                journal(f"Téléphone déconnecté → manette {manette.numero} remise au neutre")
        return ws

    async def _bonjour(self, ws):
        try:
            message = await ws.receive(timeout=DELAI_BONJOUR_S)
            contenu = json.loads(message.data) if message.type == WSMsgType.TEXT else None
        except (asyncio.TimeoutError, ValueError, TypeError):
            return None
        if not isinstance(contenu, dict) or contenu.get("t") != "bonjour":
            return None
        client_id = str(contenu.get("id", ""))[:64]
        return client_id or None

    def _recevoir_etat(self, manette, donnees):
        if len(donnees) != ETAT.size or donnees[0] != TYPE_ETAT:
            return
        try:
            manette.appliquer(donnees)
        except RuntimeError as erreur:
            journal(f"Manette {manette.numero} : le pilote a refusé la mise à jour ({erreur})")

    async def _recevoir_texte(self, ws, donnees):
        try:
            contenu = json.loads(donnees)
        except ValueError:
            return
        if isinstance(contenu, dict) and contenu.get("t") == "ping":
            await ws.send_json({"t": "pong", "ts": contenu.get("ts")})

    async def _chien_de_garde(self, manette, ws):
        while True:
            await asyncio.sleep(0.25)
            if manette.ws is ws and time.monotonic() - manette.dernier_message > CHIEN_DE_GARDE_S:
                manette.neutraliser()

    def faire_menage(self):
        maintenant = time.monotonic()
        for manette in list(self.manettes):
            if manette.ws is None and maintenant - manette.dernier_message > DELAI_RETRAIT_S:
                self.manettes.remove(manette)
                manette.retirer()
                journal(f"Manette {manette.numero} débranchée : son téléphone est parti depuis 2 min")

    async def menage(self):
        while True:
            await asyncio.sleep(10)
            self.faire_menage()

    async def arret(self, app):
        for manette in self.manettes:
            if manette.ws is not None:
                await manette.ws.close(code=1001, message=b"serveur arrete")
            manette.neutraliser()


def activer_nodelay(request):
    # Sans TCP_NODELAY, l'algorithme de Nagle peut retarder les petits messages.
    try:
        sock = request.transport.get_extra_info("socket")
        sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
    except (AttributeError, OSError):
        pass


def trouver_adb():
    chemin = shutil.which("adb")
    if chemin:
        return chemin
    bases = [os.environ.get("ANDROID_HOME"), os.environ.get("ANDROID_SDK_ROOT"),
             os.path.join(os.environ.get("LOCALAPPDATA", ""), "Android", "Sdk")]
    for base in bases:
        if base:
            candidat = Path(base) / "platform-tools" / "adb.exe"
            if candidat.exists():
                return str(candidat)
    return None


async def adb(chemin, *args):
    options = {"creationflags": subprocess.CREATE_NO_WINDOW} if sys.platform == "win32" else {}
    proc = await asyncio.create_subprocess_exec(
        chemin, *args, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, **options)
    try:
        sortie, _ = await asyncio.wait_for(proc.communicate(), 15)
    except asyncio.TimeoutError:
        proc.kill()
        return 1, ""
    return proc.returncode, sortie.decode(errors="replace")


async def surveiller_usb(chemin_adb, port):
    """Relie automatiquement chaque téléphone branché en USB : sur le téléphone,
    localhost:<port> mène alors au PC (adb reverse), quel que soit le réseau."""
    relies = set()
    signales = set()
    while True:
        try:
            _, sortie = await adb(chemin_adb, "devices")
        except OSError:
            return
        appareils = {}
        for ligne in sortie.splitlines()[1:]:
            morceaux = ligne.split()
            if len(morceaux) >= 2:
                appareils[morceaux[0]] = morceaux[1]

        for serie, etat in appareils.items():
            if etat == "device" and serie not in relies:
                code, _ = await adb(chemin_adb, "-s", serie, "reverse", f"tcp:{port}", f"tcp:{port}")
                if code == 0:
                    relies.add(serie)
                    journal(f"Téléphone branché en USB : ouvre http://localhost:{port} dans Chrome")
            elif etat == "unauthorized" and serie not in signales:
                signales.add(serie)
                journal("Téléphone branché en USB mais pas encore autorisé : "
                        "accepte « Autoriser le débogage USB » sur l'écran du téléphone")
        for serie in list(relies):
            if appareils.get(serie) != "device":
                relies.discard(serie)
                journal("Téléphone USB débranché")
        signales &= {s for s, e in appareils.items() if e == "unauthorized"}
        await asyncio.sleep(2)


@web.middleware
async def sans_cache(request, handler):
    # Savoir si la page arrive jusqu'au PC est la première question quand ça ne marche pas.
    if request.path == "/" and request.remote not in ("127.0.0.1", "::1"):
        journal(f"Page demandée par {request.remote}")
    reponse = await handler(request)
    reponse.headers["Cache-Control"] = "no-cache"
    return reponse


def ip_locale():
    # « connect » en UDP n'envoie rien : il fait juste choisir l'interface de la route par défaut.
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
        try:
            s.connect(("192.0.2.1", 9))
            return s.getsockname()[0]
        except OSError:
            return "127.0.0.1"


def autres_ip(principale):
    try:
        infos = socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET)
    except OSError:
        return []
    ips = {info[4][0] for info in infos}
    return sorted(ip for ip in ips if ip != principale and not ip.startswith(("127.", "169.254.")))


def charger_jeton(regenerer):
    config = {}
    if CONFIG.exists():
        try:
            config = json.loads(CONFIG.read_text(encoding="utf-8"))
        except ValueError:
            config = {}
    if regenerer or not config.get("jeton"):
        config["jeton"] = secrets.token_urlsafe(9)
        CONFIG.write_text(json.dumps(config, indent=2), encoding="utf-8")
    return config["jeton"]


def qr_svg(url):
    import qrcode
    import qrcode.image.svg

    image = qrcode.make(url, image_factory=qrcode.image.svg.SvgPathImage, box_size=12, border=2)
    return image.to_string(encoding="unicode")


def afficher_qr_terminal(url):
    import qrcode

    try:
        sys.stdout.reconfigure(encoding="utf-8")
        qr = qrcode.QRCode(border=1)
        qr.add_data(url)
        qr.print_ascii(invert=True)
    except (UnicodeError, OSError):
        pass  # terminal sans UTF-8 : l'URL et la page QR suffisent


def page_qr(url):
    return f"""<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><title>Manette Pixel</title>
<style>
  body {{ margin:0; min-height:100vh; display:grid; place-items:center; background:#0c0e12;
         color:#e8eaed; font:16px/1.5 system-ui, sans-serif; }}
  main {{ text-align:center; padding:24px; }}
  .qr {{ background:#fff; border-radius:16px; padding:12px; display:inline-block; }}
  .qr svg {{ width:min(70vmin, 360px); height:auto; display:block; }}
  code {{ display:block; margin:16px 0 4px; font-size:18px; color:#9fd18a; word-break:break-all; }}
  p {{ color:#a6abb3; max-width:440px; margin:8px auto; }}
</style></head>
<body><main>
  <h1>Scanne avec l'appareil photo du téléphone</h1>
  <div class="qr">{qr_svg(url)}</div>
  <code>{url}</code>
  <p>Le téléphone doit être sur le même Wi-Fi que ce PC.
     Tu peux fermer cette page, le serveur continue de tourner.</p>
  <p>Le téléphone partage sa connexion avec ce PC ? Le Wi-Fi ne marchera pas :
     branche-le en USB (débogage USB activé) et ouvre <b>http://localhost:8765</b> dans Chrome.</p>
</main></body></html>"""


def main():
    parser = argparse.ArgumentParser(description="Transforme un téléphone en manette Xbox 360 pour ce PC.")
    parser.add_argument("--port", type=int, default=PORT_DEFAUT)
    parser.add_argument("--nouveau-jeton", action="store_true", help="invalide les anciens liens et QR codes")
    parser.add_argument("--sans-navigateur", action="store_true", help="n'ouvre pas la page QR sur le PC")
    args = parser.parse_args()

    jeton = charger_jeton(args.nouveau_jeton)
    ip = ip_locale()
    url = f"http://{ip}:{args.port}/?k={jeton}"

    serveur = Serveur(jeton)
    app = web.Application(middlewares=[sans_cache])
    app["url"] = url
    app.router.add_get("/", serveur.page)
    app.router.add_get("/qr", serveur.page_qr)
    app.router.add_get("/ws", serveur.websocket)
    app.router.add_static("/static/", WEB)
    app.on_shutdown.append(serveur.arret)

    async def demarrer_menage(app):
        app["menage"] = asyncio.create_task(serveur.menage())

    async def arreter_menage(app):
        app["menage"].cancel()

    app.on_startup.append(demarrer_menage)
    app.on_cleanup.append(arreter_menage)

    print("\n  Manette Pixel")
    print("  ─────────────")
    print(f"  Ouvre sur le téléphone : {url}\n")
    afficher_qr_terminal(url)
    autres = autres_ip(ip)
    if autres:
        print("  Si le téléphone n'y arrive pas, essaie avec une de ces adresses à la place :")
        for autre in autres:
            print(f"    http://{autre}:{args.port}/?k={jeton}")
    chemin_adb = trouver_adb()
    if chemin_adb:
        print(f"\n  Par câble USB (débogage USB activé) : ouvre http://localhost:{args.port} sur le téléphone.")
        print("  Marche même quand le téléphone partage sa connexion avec le PC.")

        async def demarrer_usb(app):
            app["usb"] = asyncio.create_task(surveiller_usb(chemin_adb, args.port))

        async def arreter_usb(app):
            app["usb"].cancel()

        app.on_startup.append(demarrer_usb)
        app.on_cleanup.append(arreter_usb)
    else:
        print("\n  (adb introuvable : le mode USB est désactivé, voir README.)")

    print("\n  Rien ne se passe sur le téléphone ? Voir « Dépannage » dans le README.")
    print("  Ctrl+C pour arrêter.\n", flush=True)

    if not args.sans_navigateur:
        async def ouvrir_qr(app):
            # on_startup passe avant l'écoute du port : on laisse le serveur démarrer.
            asyncio.get_running_loop().call_later(
                0.8, webbrowser.open, f"http://127.0.0.1:{args.port}/qr")
        app.on_startup.append(ouvrir_qr)

    try:
        web.run_app(app, host="0.0.0.0", port=args.port, print=None, access_log=None)
    except OSError as erreur:
        print(f"\nImpossible d'écouter sur le port {args.port} ({erreur}).", file=sys.stderr)
        print("Le serveur tourne peut-être déjà, ou essaie avec --port 8766.", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
