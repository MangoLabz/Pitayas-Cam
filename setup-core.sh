#!/bin/bash
set -e

DIR="$(cd "$(dirname "$0")" && pwd)"

# 1. Zależności systemowe
if command -v dnf &>/dev/null; then
  dnf install -y dnf-plugins-core || true
  dnf copr enable -y zeno/scrcpy || true
  dnf install -y --skip-broken android-tools scrcpy akmod-v4l2loopback v4l-utils nodejs npm || true
elif command -v apt &>/dev/null; then
  apt update
  apt install -y --no-install-recommends adb scrcpy v4l2loopback-dkms v4l-utils nodejs npm
fi

# 2. Uruchomienie demona ADB
adb start-server || true

# 3. Uprawnienia USB
mkdir -p /etc/udev/rules.d/
# Pliki z czasów Mango Cam — zastępujemy je nowymi
rm -f /etc/udev/rules.d/99-mangocam-usb.rules /etc/modules-load.d/mangocam.conf /etc/modprobe.d/mangocam.conf
echo 'ACTION=="add", SUBSYSTEM=="usb", ATTR{power/control}="on"' > /etc/udev/rules.d/99-pitayacam-usb.rules
udevadm control --reload-rules && udevadm trigger || true

# 4. Moduł v4l2loopback (2 urządzenia, stałe numery, flagi dla Discorda)
mkdir -p /etc/modules-load.d /etc/modprobe.d
echo "v4l2loopback" > /etc/modules-load.d/pitayacam.conf
echo 'options v4l2loopback devices=2 video_nr=10,12 card_label="Pitaya Cam,Pitaya Feed" exclusive_caps=1,1 max_width=3840 max_height=2160' > /etc/modprobe.d/pitayacam.conf

modprobe -r v4l2loopback 2>/dev/null || true
modprobe v4l2loopback devices=2 video_nr=10,12 card_label="Pitaya Cam,Pitaya Feed" exclusive_caps=1,1 max_width=3840 max_height=2160 || true

# 5. Uprawnienia wideo dla użytkownika
TARGET_USER="${SUDO_USER:-$USER}"
if [ -n "$TARGET_USER" ]; then
  usermod -aG video "$TARGET_USER" || true
fi

exit 0
