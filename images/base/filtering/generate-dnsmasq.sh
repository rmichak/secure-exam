#!/bin/bash
# Generate dnsmasq and Squid allowlist rules from allowlist.txt
# This script creates server= directives for allowed domains

ALLOWLIST_FILE="/etc/squid/allowlist.txt"
DNSMASQ_OUTPUT="/etc/dnsmasq.d/allowlist.conf"
SQUID_DOMAINS_FILE="/etc/squid/allowlist-domains.txt"

# Ensure directories exist
mkdir -p /etc/dnsmasq.d
mkdir -p /etc/squid

# Clear output files
: > "$DNSMASQ_OUTPUT"
: > "$SQUID_DOMAINS_FILE"

echo "# Auto-generated dnsmasq allowlist rules" >> "$DNSMASQ_OUTPUT"
echo "# Generated at: $(date)" >> "$DNSMASQ_OUTPUT"
echo "" >> "$DNSMASQ_OUTPUT"

# Check if allowlist file exists
if [ ! -f "$ALLOWLIST_FILE" ]; then
    echo "Warning: Allowlist file not found at $ALLOWLIST_FILE"
    echo "No domains will be allowed."
    exit 0
fi

# Read allowlist and generate rules
count=0
while IFS= read -r line; do
    # Skip empty lines
    [ -z "$line" ] && continue

    # Skip comments (lines starting with #)
    case "$line" in
        \#*) continue ;;
        *) ;;
    esac

    # Trim whitespace
    domain=$(echo "$line" | tr -d '[:space:]')

    # Skip if empty after trimming
    [ -z "$domain" ] && continue

    # Add to dnsmasq allowlist - allow DNS resolution for this domain
    echo "server=/${domain}/8.8.8.8" >> "$DNSMASQ_OUTPUT"

    # Also allow subdomains with leading dot
    echo "server=/.${domain}/8.8.8.8" >> "$DNSMASQ_OUTPUT"

    # Add to Squid domains file (with and without leading dot for subdomains)
    echo ".${domain}" >> "$SQUID_DOMAINS_FILE"
    echo "${domain}" >> "$SQUID_DOMAINS_FILE"

    count=$((count + 1))

done < "$ALLOWLIST_FILE"

echo ""
echo "[generate-dnsmasq] Generated rules for $count domains"
echo "[generate-dnsmasq] dnsmasq rules: $DNSMASQ_OUTPUT"
echo "[generate-dnsmasq] Squid domains: $SQUID_DOMAINS_FILE"
