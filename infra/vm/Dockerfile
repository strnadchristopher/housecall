FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends qemu-system-x86 qemu-utils iproute2 ca-certificates && rm -rf /var/lib/apt/lists/*
COPY entrypoint.sh /usr/local/bin/chriscord-vm
ENTRYPOINT ["/bin/sh", "/usr/local/bin/chriscord-vm"]
