FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-gi python3-gst-1.0 gir1.2-gst-plugins-bad-1.0 \
    gstreamer1.0-plugins-good gstreamer1.0-plugins-bad gstreamer1.0-nice \
    nftables util-linux && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 47191 vmmedia \
    && useradd --uid 47192 --gid 47191 --no-create-home --home-dir /tmp publisher
COPY policy.py publisher.py relay.py network.py /opt/vm-media/
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 HOME=/tmp GST_DEBUG=0
ENTRYPOINT ["/usr/bin/python3", "/opt/vm-media/network.py"]
