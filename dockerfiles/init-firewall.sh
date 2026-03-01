#!/bin/bash
set -euo pipefail

# Only used when network mode = allowlist
# For open mode (default), this script is never called

ALLOWED_DOMAINS="${FORGECTL_ALLOWED_DOMAINS:-}"

iptables -F OUTPUT
iptables -P OUTPUT DROP

iptables -A OUTPUT -o lo -j ACCEPT
iptables -A OUTPUT -m state --state ESTABLISHED,RELATED -j ACCEPT

# Allow DNS
iptables -A OUTPUT -p udp --dport 53 -j ACCEPT
iptables -A OUTPUT -p tcp --dport 53 -j ACCEPT

IFS=',' read -ra DOMAINS <<< "$ALLOWED_DOMAINS"
for domain in "${DOMAINS[@]}"; do
    domain=$(echo "$domain" | xargs)
    [ -z "$domain" ] && continue
    for ip in $(dig +short "$domain" 2>/dev/null | grep -E '^[0-9]+\.' || true); do
        iptables -A OUTPUT -d "$ip" -p tcp --dport 443 -j ACCEPT
    done
done

echo "Firewall applied. Allowed: $ALLOWED_DOMAINS"
