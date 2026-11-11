#!/usr/bin/env python3
"""Private VM source. The stdlib supervisor owns authorization and process lifetime."""
import json
import multiprocessing
import os
import signal
import time
import uuid

from policy import Bridge, Config, validate_description, validate_join
from relay import DisplayRelay


def capture(config, generation, pipe):
    # No GI initialization, display connection, or audio recording in the supervisor.
    os.setsid()
    # Native plugins and multiprocessing otherwise print errors that can contain private
    # endpoint/SDP details. Report only worker termination through the supervisor.
    os.environ["GST_DEBUG"] = "0"
    with open(os.devnull, "wb") as quiet:
        os.dup2(quiet.fileno(), 2)
    import gi
    gi.require_version("Gst", "1.0")
    gi.require_version("GstWebRTC", "1.0")
    gi.require_version("GstSdp", "1.0")
    from gi.repository import GLib, Gst, GstSdp, GstWebRTC
    Gst.init(None)
    if Gst.version()[:2] < (1, 22):
        raise RuntimeError("GStreamer 1.22 or newer required")
    loop = GLib.MainLoop()
    relay = DisplayRelay(config.vnc_socket)
    pipeline = None
    try:
        # Static graph only: no caller-controlled launch string or source autoselection.
        pipeline = Gst.parse_launch(
            "webrtcbin name=rtc bundle-policy=max-bundle latency=0 "
            "rfbsrc name=display host=127.0.0.1 view-only=true shared=true do-timestamp=true ! "
            "videoconvert ! videoscale ! videorate drop-only=true ! "
            "video/x-raw,format=I420,width=1280,height=720,framerate=30/1 ! "
            "queue max-size-buffers=2 max-size-bytes=0 max-size-time=0 leaky=downstream ! "
            "vp8enc deadline=1 cpu-used=8 threads=2 target-bitrate=2500000 keyframe-max-dist=60 ! "
            "rtpvp8pay pt=96 picture-id-mode=15-bit ! "
            "application/x-rtp,media=video,encoding-name=VP8,payload=96,clock-rate=90000 ! rtc. "
            "pulsesrc name=audio device=vm_output.monitor do-timestamp=true "
            "buffer-time=40000 latency-time=10000 ! audioconvert ! audioresample ! "
            "audio/x-raw,rate=48000,channels=2 ! "
            "queue max-size-buffers=0 max-size-bytes=0 max-size-time=80000000 leaky=downstream ! "
            "opusenc bitrate=510000 audio-type=generic bandwidth=fullband frame-size=10 ! "
            "rtpopuspay pt=111 ! "
            "application/x-rtp,media=audio,encoding-name=OPUS,payload=111,clock-rate=48000 ! rtc.")
        pipeline.get_by_name("display").set_property("port", relay.port)
        pipeline.get_by_name("audio").set_property("server", "unix:" + config.pulse_socket)
        rtc = pipeline.get_by_name("rtc")
        for name in ("sink_0", "sink_1"):
            rtc.get_static_pad(name).get_property("transceiver").set_property(
                "direction", GstWebRTC.WebRTCRTPTransceiverDirection.SENDONLY)
        state = {"initial": False, "busy": False, "gather": None, "deadline": 0.0}
        bridge = Bridge(config)

        def fail(*_):
            loop.quit()
            return False

        def dispatch(fn, *args):
            # All state transitions occur on one GLib thread; promise callbacks may not.
            def run():
                try:
                    fn(*args)
                except Exception:
                    fail()
                return False
            GLib.idle_add(run)

        def promise_for(fn):
            def replied(promise, *_):
                if promise.wait() != Gst.PromiseResult.REPLIED:
                    dispatch(fail)
                    return
                reply = promise.get_reply()
                if reply is not None and reply.has_field("error"):
                    dispatch(fail)
                    return
                dispatch(fn, reply)
            return Gst.Promise.new_with_change_func(replied, None, None)

        def remote_description(value, kind, done):
            sdp = validate_description(value, kind, config)
            result, parsed = GstSdp.SDPMessage.new()
            if result != GstSdp.SDPResult.OK:
                raise ValueError("SDP allocation failed")
            if GstSdp.sdp_message_parse_buffer(sdp.encode(), parsed) != GstSdp.SDPResult.OK:
                raise ValueError("invalid remote SDP")
            description = GstWebRTC.WebRTCSessionDescription.new(
                GstWebRTC.WebRTCSDPType.ANSWER if kind == "answer" else GstWebRTC.WebRTCSDPType.OFFER,
                parsed)
            rtc.emit("set-remote-description", description, promise_for(lambda _: done()))

        def local_created(reply, kind):
            description = reply.get_value(kind)
            rtc.emit("set-local-description", description,
                     promise_for(lambda _: start_gather(kind)))

        def start_gather(kind):
            state["gather"] = kind
            state["deadline"] = time.monotonic() + 10

        def stable():
            state["busy"] = False
            state["deadline"] = 0

        def gathered(kind):
            local = rtc.get_property("local-description")
            description = {"type": kind, "sdp": local.sdp.as_text()}
            if len(description["sdp"].encode()) > 65536:
                raise ValueError("local SDP too large")
            if kind == "offer":
                joined = bridge.request("join", {"generation": generation, "offer": description})
                peer = validate_join(joined, generation, config)
                # Supervisor can revoke/leave even if setting the answer subsequently fails.
                pipe.send(peer)
                remote_description(joined["answer"], "answer", stable)
            else:
                if channel.get_property("buffered-amount") > 262144:
                    raise ValueError("signaling channel congested")
                channel.emit("send-string", json.dumps(description, separators=(",", ":")))
                stable()

        def tick():
            try:
                if state["deadline"] and time.monotonic() > state["deadline"]:
                    return fail()
                if (state["gather"] is not None and rtc.get_property("ice-gathering-state")
                        == GstWebRTC.WebRTCICEGatheringState.COMPLETE):
                    kind, state["gather"] = state["gather"], None
                    gathered(kind)
            except Exception:
                return fail()
            return True

        def negotiate():
            if state["initial"]:
                return
            state.update(initial=True, busy=True, deadline=time.monotonic() + 12)
            rtc.emit("create-offer", None, promise_for(lambda reply: local_created(reply, "offer")))

        def receive(text):
            if not isinstance(text, str) or len(text.encode()) > 131072 or state["busy"]:
                raise ValueError("invalid or overlapping renegotiation")
            value = json.loads(text)
            validate_description(value, "offer", config)
            state.update(busy=True, deadline=time.monotonic() + 12)
            remote_description(value, "offer", lambda: rtc.emit(
                "create-answer", None, promise_for(lambda reply: local_created(reply, "answer"))))

        rtc.connect("on-negotiation-needed", lambda *_: dispatch(negotiate))
        # The server grants this peer publish-only status. Inbound media is a protocol error;
        # no decoder or host/guest audio sink is ever created.
        rtc.connect("pad-added", lambda _, pad: dispatch(fail) if pad.get_direction() == Gst.PadDirection.SRC else None)
        rtc.connect("notify::connection-state", lambda *_: dispatch(fail)
                    if rtc.get_property("connection-state") in (
                        GstWebRTC.WebRTCPeerConnectionState.FAILED,
                        GstWebRTC.WebRTCPeerConnectionState.CLOSED,
                        GstWebRTC.WebRTCPeerConnectionState.DISCONNECTED) else None)
        bus = pipeline.get_bus()
        bus.add_signal_watch()
        bus.connect("message::error", fail)
        bus.connect("message::eos", fail)
        if pipeline.set_state(Gst.State.READY) == Gst.StateChangeReturn.FAILURE:
            raise RuntimeError("capture initialization failed")
        channel = rtc.emit("create-data-channel", "housecall-signaling", None)
        if channel is None:
            raise RuntimeError("data channel unavailable")
        channel.connect("on-message-string", lambda _, text: dispatch(receive, text))
        channel.connect("on-error", fail)
        channel.connect("on-close", fail)
        if pipeline.set_state(Gst.State.PLAYING) == Gst.StateChangeReturn.FAILURE:
            raise RuntimeError("capture failed")
        GLib.timeout_add(25, tick)
        loop.run()
    finally:
        if pipeline is not None:
            pipeline.set_state(Gst.State.NULL)
        relay.close()
        pipe.close()


def stop_capture(process):
    # multiprocessing retains ownership of the child; never kill a reaped numeric process group.
    # GI creates threads, not child processes. Kill only this live child, then reap it.
    if process.is_alive():
        process.terminate()
        process.join(timeout=0.15)
    if process.is_alive():
        process.kill()
    process.join(timeout=0.15)


def run(config, stop=None, context=None):
    stop = stop or multiprocessing.Event()
    context = context or multiprocessing.get_context("spawn")
    bridge = Bridge(config)
    while not stop.is_set():
        try:
            armed = bridge.request("status").get("armed") is True
        except Exception:
            armed = False
        if not armed:
            stop.wait(1)
            continue
        generation = str(uuid.uuid4())
        reader, writer = context.Pipe(duplex=False)
        process = context.Process(target=capture, args=(config, generation, writer), daemon=True)
        peer = None
        try:
            process.start()
            writer.close()
            deadline = time.monotonic() + 15
            while process.is_alive() and not stop.is_set():
                if reader.poll():
                    peer = reader.recv()
                    if type(peer) is not int or peer <= 0:
                        raise ValueError("invalid worker identity")
                if peer is None:
                    if time.monotonic() > deadline or bridge.request("status").get("armed") is not True:
                        break
                elif bridge.request("heartbeat", {"generation": generation, "peer_id": peer}).get("active") is not True:
                    break
                stop.wait(0.5)
        except Exception:
            pass  # Do not log SDP, paths, Pulse errors, framebuffer content, or user data.
        finally:
            if process.pid is not None:
                stop_capture(process)
            reader.close()
            writer.close()
            # Join may have succeeded before its reply/worker handoff was lost. Leave the
            # generation even without a peer ID; the bridge must disarm that generation.
            try:
                bridge.request("leave", {"generation": generation, "peer_id": peer})
            except Exception:
                pass  # The server independently expires the source grant after three seconds.
        stop.wait(1)


if __name__ == "__main__":
    stopping = multiprocessing.Event()
    signal.signal(signal.SIGTERM, lambda *_: stopping.set())
    signal.signal(signal.SIGINT, lambda *_: stopping.set())
    try:
        run(Config.environment(), stopping)
    except Exception:
        raise SystemExit("VM publisher configuration or runtime unavailable") from None
