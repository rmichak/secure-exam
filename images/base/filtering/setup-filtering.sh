#!/bin/bash
# Setup script for website filtering (runs at container startup)
# Simple DNS-based filtering using dnsmasq

echo "[Filtering] Setting up website allowlist filtering..."

# Start dnsmasq for DNS filtering
echo "[Filtering] Starting dnsmasq..."
dnsmasq --conf-file=/etc/dnsmasq.conf || {
    echo "[Filtering] Warning: dnsmasq failed to start"
}

# Configure system to use local DNS
echo "nameserver 127.0.0.1" > /etc/resolv.conf

# Block external DNS to prevent bypass
echo "[Filtering] Configuring DNS firewall rules..."
iptables -A OUTPUT -p udp --dport 53 -d 127.0.0.1 -j ACCEPT 2>/dev/null || true
iptables -A OUTPUT -p tcp --dport 53 -d 127.0.0.1 -j ACCEPT 2>/dev/null || true
iptables -A OUTPUT -p udp --dport 53 -j DROP 2>/dev/null || true
iptables -A OUTPUT -p tcp --dport 53 -j DROP 2>/dev/null || true

echo "[Filtering] Website filtering is now active (DNS-based)."
echo "[Filtering] Allowed domains loaded from /etc/squid/allowlist.txt"
