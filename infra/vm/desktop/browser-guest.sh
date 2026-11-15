#!/bin/bash
# Run offline in virt-customize --run: never against an existing production overlay.
set -eux
useradd --create-home --shell /bin/bash browser
passwd -l root
passwd -l browser
rm -f /etc/ssh/ssh_host_*
systemctl disable ssh.service ssh.socket 2>/dev/null || true
systemctl mask getty@tty1.service serial-getty@ttyS0.service
mkdir -p /etc/lightdm/lightdm.conf.d /home/browser/.config/openbox /etc/firefox/policies
cat > /etc/lightdm/lightdm.conf.d/housecall.conf <<'EOF'
[Seat:*]
autologin-user=browser
autologin-user-timeout=0
user-session=openbox
xserver-command=X -nolisten tcp
EOF
cat > /home/browser/.config/openbox/autostart <<'EOF'
xrandr -s 1280x720
xset s off
xset -dpms
pulseaudio --start
firefox-esr --no-remote --kiosk file:///usr/local/share/housecall/start.html &
EOF
mkdir -p /usr/local/share/housecall
cat > /usr/local/share/housecall/start.html <<'EOF'
<!doctype html><html><head><meta charset="utf-8"><title>Housecall Shared Browser</title><style>body{background:#17202b;color:#eef1f5;font:24px sans-serif;padding:10vw}a{color:#86dbff}input{font:24px sans-serif;width:70%;padding:14px}</style></head><body><h1>Housecall Shared Browser</h1><p>Debian · Firefox ESR · VPN-only browsing</p><form action="https://duckduckgo.com/" method="get"><input name="q" placeholder="Search the web" autofocus></form><p>Shared with your voice channel only when its host arms capture.</p></body></html>
EOF
cat > /etc/firefox/policies/policies.json <<'EOF'
{"policies":{"DisableTelemetry":true,"DisableFirefoxStudies":true,"DontCheckDefaultBrowser":true,"OverrideFirstRunPage":"","OverridePostUpdatePage":"","Preferences":{"network.trr.mode":{"Value":5,"Status":"locked"},"network.dns.disableIPv6":{"Value":true,"Status":"locked"},"media.autoplay.default":{"Value":0,"Status":"locked"}}}}
EOF
cat > /etc/sysctl.d/90-housecall.conf <<'EOF'
net.ipv6.conf.all.disable_ipv6=1
net.ipv6.conf.default.disable_ipv6=1
EOF
rm -f /etc/resolv.conf
printf 'nameserver 1.1.1.1\nnameserver 9.9.9.9\n' > /etc/resolv.conf
touch /etc/cloud/cloud-init.disabled
systemctl enable lightdm
systemctl set-default graphical.target
chown -R browser:browser /home/browser
# No inherited cloud fixture root autologin or passwordless sudo.
rm -rf /etc/systemd/system/getty@tty1.service.d /etc/systemd/system/serial-getty@ttyS0.service.d
rm -f /etc/sudoers.d/90-cloud-init-users
apt-get purge -y openssh-server || true
apt-get clean
truncate -s 0 /etc/machine-id
rm -f /var/lib/dbus/machine-id
ln -s /etc/machine-id /var/lib/dbus/machine-id
