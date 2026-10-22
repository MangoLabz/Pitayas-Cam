#!/bin/bash

# 1. Sprawdzenie i ewentualne dociągnięcie zenity do wyświetlania okienek
if ! command -v zenity &>/dev/null; then
  echo "Instalowanie interfejsu graficznego dla instalatora..."
  sudo dnf install -y zenity >/dev/null 2>&1 || sudo apt install -y zenity >/dev/null 2>&1
fi

# Okno powitalne
zenity --question --title="Instalator Pitaya Cam" --width=380 \
  --text="Czy chcesz zainstalować Pitaya Cam wraz ze wszystkimi zależnościami (ADB, scrcpy, v4l2loopback, NodeJS)?" || exit 0

(
  echo "10"; echo "# 1/5: Sprawdzanie i instalowanie pakietów systemowych..."
  if command -v dnf &>/dev/null; then
    sudo dnf install -y https://mirrors.rpmfusion.org/free/fedora/rpmfusion-free-release-$(rpm -E %fedora).noarch.rpm >/dev/null 2>&1
    sudo dnf install -y android-tools scrcpy ffmpeg akmod-v4l2loopback v4l-utils nodejs npm openssl >/dev/null 2>&1
    sudo usermod -aG video $USER >/dev/null 2>&1
  elif command -v apt &>/dev/null; then
    sudo apt update >/dev/null 2>&1
    sudo apt install -y adb scrcpy ffmpeg v4l2loopback-dkms v4l-utils nodejs npm openssl >/dev/null 2>&1
    sudo usermod -aG video $USER >/dev/null 2>&1
  fi

  echo "35"; echo "# 2/5: Konfiguracja uprawnień USB i wyłączanie uśpienia..."
  sudo mkdir -p /etc/udev/rules.d/
  # Pliki z czasów Mango Cam — zastępujemy je nowymi
  sudo rm -f /etc/udev/rules.d/99-mangocam-usb.rules /etc/modules-load.d/mangocam.conf /etc/modprobe.d/mangocam.conf
  echo 'ACTION=="add", SUBSYSTEM=="usb", ATTR{power/control}="on"' | sudo tee /etc/udev/rules.d/99-pitayacam-usb.rules >/dev/null
  sudo udevadm control --reload-rules >/dev/null 2>&1 && sudo udevadm trigger >/dev/null 2>&1

  echo "50"; echo "# 3/5: Ładowanie modułu wirtualnej kamery (v4l2loopback)..."
  echo "v4l2loopback" | sudo tee /etc/modules-load.d/pitayacam.conf >/dev/null
  echo 'options v4l2loopback devices=1 video_nr=10 card_label="Pitaya Cam" exclusive_caps=1 max_width=3840 max_height=2160' | sudo tee /etc/modprobe.d/pitayacam.conf >/dev/null
  sudo modprobe -r v4l2loopback >/dev/null 2>&1
  sudo modprobe v4l2loopback devices=1 video_nr=10 card_label="Pitaya Cam" exclusive_caps=1 max_width=3840 max_height=2160 >/dev/null 2>&1

  echo "70"; echo "# 4/5: Generowanie certyfikatu SSL dla transmisji iPhone (HTTPS)..."
  APP_DIR=$(pwd)
  cd "$APP_DIR" || exit 1
  if [ ! -f "key.pem" ] || [ ! -f "cert.pem" ]; then
    openssl req -x509 -newkey rsa:2048 -nodes -keyout key.pem -out cert.pem -days 365 -subj "/CN=pitayacam" >/dev/null 2>&1
  fi

  echo "85"; echo "# 5/5: Pobieranie i budowanie modułów Electrona..."
  npm install --silent >/dev/null 2>&1

  # Utworzenie skrótu w menu programów
  mkdir -p ~/.local/share/applications
  rm -f ~/.local/share/applications/mangocam.desktop
  cat << DSK_EOF > ~/.local/share/applications/pitayacam.desktop
[Desktop Entry]
Type=Application
Name=Pitaya Cam
Comment=Virtual Camera Hub (Android & iPhone)
Exec=npm start --prefix $APP_DIR
Icon=$APP_DIR/assets/icon.svg
Terminal=false
Categories=AudioVideo;Video;
DSK_EOF
  update-desktop-database ~/.local/share/applications >/dev/null 2>&1

  # Start demona ADB na wypadek gdyby nie działał
  adb start-server >/dev/null 2>&1

  echo "100"; echo "# Instalacja ukończona pomyślnie!"
) | zenity --progress --title="Instalacja Pitaya Cam" --percentage=0 --auto-close --width=440

if [ $? -eq 0 ]; then
  zenity --info --title="Gotowe" --text="Pitaya Cam zostało pomyślnie zainstalowane!\n\nZależności ADB, scrcpy, certyfikaty i moduły kamery są skonfigurowane. Możesz uruchomić aplikację z menu programów." --width=380
fi
