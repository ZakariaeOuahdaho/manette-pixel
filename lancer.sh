#!/usr/bin/env bash
# Linux : installe ce qui manque au premier lancement, puis démarre le serveur.
set -u
cd "$(dirname "$(readlink -f "$0")")" || exit 1

REGLE=/etc/udev/rules.d/70-manette-pixel.rules
VENV=.venv-linux  # distinct du .venv Windows : le même dossier peut servir aux deux

# Python 3.10 à 3.14, avec venv (sur Debian/Ubuntu, il est dans un paquet à part).
PYTHON=""
for candidat in python3.13 python3.12 python3.11 python3.10 python3.14 python3; do
    if command -v "$candidat" >/dev/null 2>&1 && "$candidat" -c \
        'import sys, venv, ensurepip; sys.exit(not (3, 10) <= sys.version_info < (3, 15))' 2>/dev/null; then
        PYTHON=$candidat
        break
    fi
done
if [ -z "$PYTHON" ]; then
    echo "Il faut Python 3.10 ou plus, avec venv. Installe-le, puis relance ./lancer.sh :"
    echo "  Debian, Ubuntu, Mint : sudo apt install python3 python3-venv"
    echo "  Fedora               : sudo dnf install python3"
    echo "  Arch, Manjaro        : sudo pacman -S python"
    exit 1
fi

# libevdev crée la manette virtuelle.
if ! "$PYTHON" -c 'import ctypes.util, sys; sys.exit(ctypes.util.find_library("evdev") is None)'; then
    echo "Il faut la bibliothèque libevdev. Installe-la, puis relance ./lancer.sh :"
    echo "  Debian, Ubuntu, Mint : sudo apt install libevdev2"
    echo "  Fedora               : sudo dnf install libevdev"
    echo "  Arch, Manjaro        : sudo pacman -S libevdev"
    exit 1
fi

# Règle système, une seule fois : donne à l'utilisateur connecté l'accès à /dev/uinput
# (manette virtuelle) et au téléphone en USB (adb), sans sudo à chaque partie.
if [ ! -f "$REGLE" ]; then
    echo
    echo "Une règle système est nécessaire (une seule fois) pour que ton compte puisse"
    echo "créer la manette virtuelle et parler au téléphone branché en USB."
    read -r -p "L'installer maintenant ? Ton mot de passe sera demandé. [O/n] " reponse
    case "$reponse" in
        [nN]*) echo "Règle non installée : la manette risque d'être refusée." ;;
        *)
            sudo tee "$REGLE" >/dev/null <<'FIN' &&
# Manette Pixel : accès de l'utilisateur connecté à la manette virtuelle et au téléphone (adb).
KERNEL=="uinput", SUBSYSTEM=="misc", OPTIONS+="static_node=uinput", TAG+="uaccess"
SUBSYSTEM=="usb", ENV{DEVTYPE}=="usb_device", ENV{ID_USB_INTERFACES}=="*:ff4201:*", TAG+="uaccess"
FIN
            echo uinput | sudo tee /etc/modules-load.d/manette-pixel.conf >/dev/null &&
            sudo modprobe uinput &&
            sudo udevadm control --reload-rules &&
            sudo udevadm trigger --subsystem-match=misc --subsystem-match=usb &&
            sudo udevadm settle &&
            echo "Règle installée." ||
            echo "L'installation de la règle a échoué."
            ;;
    esac
fi

# Environnement Python du projet : refait s'il manque, s'il est cassé ou si les dépendances ont changé.
if ! cmp -s requirements.txt "$VENV/requirements.txt" ||
   ! "$VENV/bin/python" -c 'import aiohttp, qrcode, vgamepad' 2>/dev/null; then
    echo "Installation des composants (une seule fois, environ 1 min)..."
    rm -rf "$VENV"
    if ! { "$PYTHON" -m venv "$VENV" &&
           "$VENV/bin/python" -m pip install --disable-pip-version-check -q -r requirements.txt; }; then
        echo "L'installation a échoué. Vérifie la connexion Internet, puis relance ./lancer.sh."
        exit 1
    fi
    cp requirements.txt "$VENV/requirements.txt"
    echo "Installation terminée."
fi

exec "$VENV/bin/python" serveur.py "$@"
