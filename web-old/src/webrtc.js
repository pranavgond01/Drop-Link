const DEFAULT_ICE = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
    ],
};
export function getIceConfig() {
    const raw = import.meta.env.VITE_ICE_SERVERS;
    if (!raw)
        return DEFAULT_ICE;
    try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed))
            return { iceServers: parsed };
    }
    catch {
        // Ignore malformed optional configuration and fall back to public STUN.
    }
    return DEFAULT_ICE;
}
export class WebRtcPeer {
    pc;
    dataChannel;
    callbacks;
    localId;
    remoteId;
    pendingCandidates = [];
    constructor(localId, remoteId, callbacks) {
        this.localId = localId;
        this.remoteId = remoteId;
        this.callbacks = callbacks;
        this.pc = new RTCPeerConnection(getIceConfig());
        this.pc.onicecandidate = (event) => {
            if (!event.candidate)
                return;
            this.callbacks.onSignal({
                type: 'ice-candidate',
                from: this.localId,
                to: this.remoteId,
                candidate: event.candidate.toJSON(),
            });
        };
        this.pc.onconnectionstatechange = () => {
            this.callbacks.onConnection(this.pc.connectionState);
        };
        this.pc.ondatachannel = (event) => {
            this.attachDataChannel(event.channel);
        };
    }
    get connectionState() {
        return this.pc.connectionState;
    }
    get channel() {
        return this.dataChannel;
    }
    attachDataChannel(channel) {
        this.dataChannel = channel;
        channel.binaryType = 'arraybuffer';
        channel.bufferedAmountLowThreshold = 512 * 1024;
        channel.onmessage = (event) => {
            if (typeof event.data === 'string') {
                try {
                    this.callbacks.onControl(JSON.parse(event.data));
                }
                catch {
                    // Ignore malformed control messages.
                }
                return;
            }
            if (event.data instanceof ArrayBuffer) {
                this.callbacks.onBinary(event.data);
                return;
            }
            if (event.data instanceof Blob) {
                event.data.arrayBuffer().then((buffer) => this.callbacks.onBinary(buffer));
            }
        };
    }
    createChannel() {
        const channel = this.pc.createDataChannel('droplink', {
            ordered: true,
        });
        this.attachDataChannel(channel);
    }
    sendControl(message) {
        if (!this.dataChannel || this.dataChannel.readyState !== 'open') {
            throw new Error('P2P data channel is not open.');
        }
        this.dataChannel.send(JSON.stringify(message));
    }
    sendBinary(buffer) {
        if (!this.dataChannel || this.dataChannel.readyState !== 'open') {
            throw new Error('P2P data channel is not open.');
        }
        this.dataChannel.send(buffer);
    }
    async createOffer() {
        const offer = await this.pc.createOffer();
        await this.pc.setLocalDescription(offer);
        if (!this.pc.localDescription)
            throw new Error('Missing local description.');
        this.callbacks.onSignal({
            type: 'offer',
            from: this.localId,
            to: this.remoteId,
            sdp: this.pc.localDescription,
        });
    }
    async handleOffer(sdp) {
        await this.pc.setRemoteDescription(sdp);
        for (const candidate of this.pendingCandidates.splice(0)) {
            await this.pc.addIceCandidate(candidate);
        }
        const answer = await this.pc.createAnswer();
        await this.pc.setLocalDescription(answer);
        if (!this.pc.localDescription)
            throw new Error('Missing local description.');
        this.callbacks.onSignal({
            type: 'answer',
            from: this.localId,
            to: this.remoteId,
            sdp: this.pc.localDescription,
        });
    }
    async handleAnswer(sdp) {
        await this.pc.setRemoteDescription(sdp);
        for (const candidate of this.pendingCandidates.splice(0)) {
            await this.pc.addIceCandidate(candidate);
        }
    }
    async handleIce(candidate) {
        if (!this.pc.remoteDescription) {
            this.pendingCandidates.push(candidate);
            return;
        }
        await this.pc.addIceCandidate(candidate);
    }
    waitForChannel() {
        if (this.dataChannel?.readyState === 'open')
            return Promise.resolve(this.dataChannel);
        return new Promise((resolve, reject) => {
            const channel = this.dataChannel;
            if (!channel) {
                const timeout = window.setTimeout(() => reject(new Error('Timed out waiting for data channel.')), 30000);
                const check = window.setInterval(() => {
                    if (this.dataChannel?.readyState === 'open') {
                        clearTimeout(timeout);
                        clearInterval(check);
                        resolve(this.dataChannel);
                    }
                    if (this.pc.connectionState === 'failed' || this.pc.connectionState === 'closed') {
                        clearTimeout(timeout);
                        clearInterval(check);
                        reject(new Error('Peer connection failed.'));
                    }
                }, 200);
                return;
            }
            const onOpen = () => {
                channel.removeEventListener('open', onOpen);
                resolve(channel);
            };
            channel.addEventListener('open', onOpen);
        });
    }
    close() {
        this.dataChannel?.close();
        this.pc.close();
    }
}
