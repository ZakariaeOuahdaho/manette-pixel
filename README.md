# Manette Pixel

Ce projet transforme le téléphone en **manette Xbox 360** pour ce PC, sans rien installer sur le
téléphone. Le PC sert une page web, le téléphone l'ouvre dans Chrome, et chaque toucher
pilote une manette virtuelle que Windows et les jeux voient comme une vraie manette.

```
Téléphone (Chrome) ──WebSocket, Wi-Fi local──▶ serveur.py ──vgamepad──▶ ViGEmBus ──▶ le jeu
```

## Lancer

1. Double-clic sur **`lancer.bat`**. La première fois, il installe les dépendances
   (environ 30 s).
2. Une page avec un QR code s'ouvre sur le PC. Scanne-le avec l'appareil photo du
   téléphone. Le QR code s'affiche aussi dans le terminal.
3. Touche **Jouer** : la page passe en plein écran et à l'horizontale.

Le téléphone et le PC doivent être sur **le même Wi-Fi**.

### Par câble USB : quand le téléphone partage sa 4G avec le PC

Si c'est le téléphone qui donne Internet au PC (partage de connexion), la méthode Wi-Fi
**ne peut pas marcher**. Android envoie le trafic de Chrome par la 4G : la page n'atteint
jamais le PC, et Chrome affiche `ERR_ABORTED` ou `ERR_TOO_MANY_RETRIES`. Passe alors par
le câble. C'est aussi la méthode la plus stable, avec la latence la plus basse.

À faire une seule fois sur le Pixel :
1. *Paramètres → À propos du téléphone* : touche 7 fois **Numéro de build** pour
   débloquer les options pour les développeurs.
2. *Paramètres → Système → Options pour les développeurs* : active **Débogage USB**.

Ensuite, à chaque partie :
1. Lance `lancer.bat` et branche le téléphone en USB. Au premier branchement, accepte
   **« Autoriser le débogage USB »** et coche « Toujours autoriser ».
2. Le terminal affiche « Téléphone branché en USB ». Dans Chrome, ouvre
   **`http://localhost:8765`**. Il n'y a pas de code à taper.

Le serveur relie tout seul chaque téléphone branché, y compris après un débranchement.
Le partage 4G peut rester actif à côté. En USB, l'écran du téléphone reste aussi allumé
pendant la partie. Le mode USB a besoin d'`adb` : il est fourni avec Android Studio, et le
serveur le trouve tout seul s'il est dans le PATH ou dans le SDK Android par défaut.

### Pré-requis

- Python 3.10 ou plus.
- Le pilote **ViGEmBus** ([releases](https://github.com/nefarius/ViGEmBus/releases)). Il est
  déjà présent si DS4Windows est installé. Le serveur indique clairement s'il est absent.

## Commandes

| Commande | Comment |
|---|---|
| Joysticks | Ils sont **flottants** : le centre se pose là où le pouce touche, dans la moitié du bas de l'écran pour le joystick droit. Si le pouce dépasse le bord, le centre le suit. |
| L3 / R3 (clic du joystick) | **Double-tape puis maintiens** le joystick. Le pommeau devient vert, et tu peux continuer à diriger pendant ce temps (par exemple pour sprinter). |
| Croix | Le pouce peut glisser d'une direction à l'autre, diagonales comprises, et déborder de la croix sans la lâcher. |
| A B X Y | Le pouce glisse d'un bouton à l'autre. Un appui **entre** deux boutons voisins presse les deux (désactivable). |
| LT LB / RB RT | Les gâchettes sont en haut. Glisser de l'une à l'autre fonctionne aussi. |
| Pastille en bas | Elle affiche le n° de joueur et la latence. Un appui ouvre les **réglages**. |

Les réglages sont enregistrés sur le téléphone : taille, opacité, zone morte, course des
joysticks, joysticks fixes ou flottants, vibrations.

Le serveur accepte **jusqu'à 4 téléphones**, soit 4 manettes et donc 4 joueurs.

## Ce qui le rend fiable

- **État complet à chaque message**, jamais des « appui / relâche ». Un bouton ne peut pas
  rester coincé, car le message suivant corrige tout.
- **Chien de garde** : si le téléphone se tait plus d'une seconde (écran verrouillé, Wi-Fi
  coupé), la manette revient au neutre. Le personnage ne court pas tout seul dans un mur.
- **Reconnexion automatique**, sur la *même* manette virtuelle : le jeu ne voit pas de
  débranchement.
- Quand une fenêtre recouvre la manette (réglages, pause, téléphone tourné en portrait,
  application en arrière-plan), tout est relâché.
- Le geste « retour » d'Android quitte seulement le plein écran (la partie se met en pause).
  Il ne quitte pas la page.
- Les vibrations envoyées par le jeu font vibrer le téléphone.

## Dépannage

**Le téléphone reste sur « Reconnexion… » ou « PC injoignable »**

1. Vérifie que les deux appareils sont sur le même Wi-Fi. Les réseaux invités ou
   d'entreprise isolent souvent les appareils entre eux.
2. **Pare-feu Windows** : au premier lancement, Windows demande s'il faut autoriser Python.
   Il faut accepter. Si tu as refusé, ou si ton Wi-Fi est en profil « Public », lance cette
   commande dans un PowerShell **administrateur** :
   ```
   New-NetFirewallRule -DisplayName "Manette Pixel" -Direction Inbound -Protocol TCP -LocalPort 8765 -Action Allow -Profile Private,Public
   ```
3. Le terminal liste d'autres adresses IP du PC. Essaie-les si la première ne répond pas.
4. **Wi-Fi d'école, de résidence ou public**, ou **téléphone qui partage sa connexion avec
   le PC** : le téléphone ne peut pas joindre le PC par le Wi-Fi, quoi qu'on fasse. Passe
   par le câble USB (voir « Par câble USB » plus haut).

**« Lien invalide »** : rescanne le QR code. Le lien contient un code secret qui empêche
les autres appareils du Wi-Fi de prendre la main. `lancer.bat --nouveau-jeton` en génère un
nouveau et invalide les anciens liens.

**Le jeu ne réagit pas** : vérifie dans `joy.cpl` (Win+R) que « Controller (XBOX 360 For
Windows) » apparaît et bouge quand tu touches l'écran. Certains jeux ne prennent en compte
une manette que si elle est branchée avant leur lancement.

## Options

```
lancer.bat --port 8766          change le port (8765 par défaut)
lancer.bat --nouveau-jeton      invalide les liens et QR codes déjà donnés
lancer.bat --sans-navigateur    n'ouvre pas la page QR sur le PC
```

## Fichiers

- `serveur.py` : le serveur web et la manette virtuelle.
- `web/` : l'interface du téléphone (`index.html`, `style.css`, `app.js`), sans dépendance.
- `config.json` : le jeton d'accès, créé au premier lancement.
