FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends qemu-system-x86 qemu-utils iproute2 nftables ca-certificates && rm -rf /var/lib/apt/lists/*
COPY install-policy.sh /usr/local/bin/install-vm-policy
COPY policy-entrypoint.sh /usr/local/bin/vm-policy-entrypoint
RUN chmod 755 /usr/local/bin/install-vm-policy /usr/local/bin/vm-policy-entrypoint
COPY entrypoint.sh /usr/local/bin/chriscord-vm
ENTRYPOINT ["/bin/sh", "/usr/local/bin/chriscord-vm"]
