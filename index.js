'user strict';

// Specify the file circuit.js which is the browser SDK to get access to WebRTC APIs.
const Circuit = require('circuit-sdk/circuit.js');

var videoOutput;
var pipeline;
var webRtcPeer;
var client;
var call;
var url;
let streaming = false;


BOT_CONFIG.allowedConversations = BOT_CONFIG.allowedConversations || [];

// Set ICE servers, or use freeice otherwise
if (BOT_CONFIG.kurento.ice_servers) {
    console.log(`Using ICE servers: ${BOT_CONFIG.kurento.ice_servers}`);
    kurentoUtils.WebRtcPeer.prototype.server.iceServers = JSON.parse(BOT_CONFIG.kurento.ice_servers);
} else {
    console.log('Use freeice');
}

function logon() {
    Circuit.logger.setLevel(Circuit.Enums.LogLevel.Debug);
    Circuit.WebRTCAdapter.unifiedPlanEnabled = true;
    client = new Circuit.Client(BOT_CONFIG.circuit);
    return client.logon();
}

async function startConference(convId) {
    const conv = await client.getConversationById(convId);
    if (!conv) {
        return;
    }
    const activeCall = await client.findCall(conv.rtcSessionId);
    if (activeCall) {
        await client.joinConference(activeCall.callId, { audio: false, video: false });
        call = activeCall;
    } else {
        console.log('dronebot: starting conference...');
        call = await client.startConference(convId, { audio: false, video: false });
        console.log('dronebot: conference started. wait a few seconds');
    }
    await sleep(1000); // Wait for conference to be ready, or having joined
    console.log('dronebot: done waiting');
}

async function streamVideoInConv(stream) {
    if (!stream || !client || !call) {
        return;
    }

    console.log('dronebot: start stream', stream);

    try {
        await client.setAudioVideoStream(call.callId, stream);
        //await client.unmute(call.callId);  // unmute if drone has sound
        } catch (err) {
        console.error(err);
    }
}

function addEventListeners() {
    // Listen for mention events like "@dronebot stream rtsp://...."
    client.addEventListener('mention', async evt => {
        const itemReference = evt.mention && evt.mention.itemReference;

        if (BOT_CONFIG.allowedConversations.length && !BOT_CONFIG.allowedConversations.includes(itemReference.convId)) {
            // Not allowed to stream on this conversation
            return;
        }

        const item = await client.getItemById(itemReference.itemId);
        if (item.text.content.includes('stream rtsp://')) {
            url = item.text.content.substring(item.text.content.indexOf('rtsp://')).trim();
            await startConference(itemReference.convId);
            startStreaming(url);
        }
    });

    client.addEventListener('callStatus', async evt => {
        if (call && evt.call.callId === call.callId) {
            console.log('dronebot: callStatus', evt);

            if (evt.call.state === Circuit.Enums.CallStateName.Terminated) {
                // Bot has been dropped
                stop();
            }
        } else {
            console.log('dronebot: callStatus event for a different call');
        }
    });

    client.addEventListener('callEnded', async evt => {
        if (call && evt.call.callId === call.callId) {
            // Stop streaming
            console.log('dronebot: stop stream');
            stop();
        }
    });
}

function startStreaming() {
    var options = {
        remoteVideo: videoOutput
    };
    webRtcPeer = kurentoUtils.WebRtcPeer.WebRtcPeerRecvonly(options,
        function (error) {
            if (error) {
                return console.error(error);
            }
            webRtcPeer.generateOffer(onOffer);
            webRtcPeer.peerConnection.addEventListener('iceconnectionstatechange', async function (event) {
                if (webRtcPeer && webRtcPeer.peerConnection) {
                    console.log("oniceconnectionstatechange -> " + webRtcPeer.peerConnection.iceConnectionState);
                    console.log('icegatheringstate -> ' + webRtcPeer.peerConnection.iceGatheringState);
                }
            });

            webRtcPeer.peerConnection.ontrack = function (event) {
                console.log('ontrack event with stream', event.streams[0]);
                var stream = webRtcPeer.getRemoteStream();
                if (stream && stream.active && !streaming) {
                    streaming = true;
                    streamVideoInConv(webRtcPeer.getRemoteStream());
                }
            };
        });
}

function onOffer(error, sdpOffer) {
    if (error) return onError(error);

    kurentoClient(BOT_CONFIG.kurento.ws_uri, function (error, kurentoClient) {
        if (error) return onError(error);

        kurentoClient.create("MediaPipeline", function (error, p) {
            if (error) return onError(error);

            pipeline = p;

            pipeline.create("PlayerEndpoint", { uri: url }, function (error, player) {
                if (error) return onError(error);

                pipeline.create("WebRtcEndpoint", function (error, webRtcEndpoint) {
                    if (error) return onError(error);

                    setIceCandidateCallbacks(webRtcEndpoint, webRtcPeer, onError);

                    webRtcEndpoint.processOffer(sdpOffer, function (error, sdpAnswer) {
                        if (error) return onError(error);

                        webRtcEndpoint.gatherCandidates(onError);
                        webRtcPeer.processAnswer(sdpAnswer);
                    });

                    player.connect(webRtcEndpoint, function (error) {
                        if (error) return onError(error);

                        console.log("PlayerEndpoint-->WebRtcEndpoint connection established");

                        player.play(function (error) {
                            if (error) return onError(error);

                            console.log("Player playing ...");
                        });
                    });
                });
            });
        });
    });
}

async function stop() {
    if (webRtcPeer) {
        webRtcPeer.dispose();
        webRtcPeer = null;
    }
    if (pipeline) {
        pipeline.release();
        pipeline = null;
    }

    streaming = false;
    if (call) {
        client.endCall(call.callId);
        call = null;
    }
}

function sleep(time) {
    return new Promise((resolve) => setTimeout(resolve, time));
}

function setIceCandidateCallbacks(webRtcEndpoint, webRtcPeer, onError) {
    webRtcPeer.on('icecandidate', function (candidate) {
        console.log("Local icecandidate " + JSON.stringify(candidate));

        candidate = kurentoClient.register.complexTypes.IceCandidate(candidate);

        webRtcEndpoint.addIceCandidate(candidate, onError);

    });
    webRtcEndpoint.on('OnIceCandidate', function (event) {
        var candidate = event.candidate;

        console.log("Remote icecandidate " + JSON.stringify(candidate));

        webRtcPeer.addIceCandidate(candidate, onError);
    });
}

function onError(error) {
    if (error) {
        console.error(error);

        if (error && error.data && error.data.type === 'ICE_ADD_CANDIDATE_ERROR') {
            return;
        }
        stop();
    }
}

window.addEventListener('load', function () {
    videoOutput = document.getElementById('videoOutput');
});

(async () => {
    try {
        user = await logon();
        addEventListeners();

    } catch (err) {
        console.error(err);
    }
})();
