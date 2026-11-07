FROM alpine:3.22
RUN apk add --no-cache wireguard-tools wireguard-go iproute2 iptables nftables curl bind-tools dnsmasq python3
COPY fixture.py /fixture.py
ENTRYPOINT ["python3", "/fixture.py"]
