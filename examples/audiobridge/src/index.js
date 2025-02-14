'use strict';

const fs = require('fs');
const path = require('path');
const Janode = require('../../../src/janode.js');
const { janode: janodeConfig, web: serverConfig } = require('./config.js');

const { Logger } = Janode;
const LOG_NS = `[${path.basename(__filename)}]`;
const AudioBridgePlugin = require('../../../src/plugins/audiobridge-plugin');

const express = require('express');
const app = express();
const options = {
  key: serverConfig.key ? fs.readFileSync(serverConfig.key) : null,
  cert: serverConfig.cert ? fs.readFileSync(serverConfig.cert) : null,
};
const server = (options.key && options.cert) ? require('https').createServer(options, app) : require('http').createServer(app);
const io = require('socket.io')(server);

const scheduleBackEndConnection = (function () {
  let task = null;

  return (function (del = 10) {
    if (task) return;
    Logger.info(`${LOG_NS} scheduled connection in ${del} seconds`);
    task = setTimeout(() => {
      initBackEnd()
        .then(() => task = null)
        .catch(() => {
          task = null;
          scheduleBackEndConnection();
        });
    }, del * 1000);
  });
})();

let janodeSession;
let janodeManagerHandle;

(function main() {

  initFrontEnd().catch(({ message }) => Logger.error(`${LOG_NS} failure initializing front-end: ${message}`));

  scheduleBackEndConnection(1);

})();

async function initBackEnd() {
  Logger.info(`${LOG_NS} connecting Janode...`);
  let connection;

  try {
    connection = await Janode.connect(janodeConfig);
    Logger.info(`${LOG_NS} connection with Janus created`);

    connection.once(Janode.EVENT.CONNECTION_CLOSED, () => {
      Logger.info(`${LOG_NS} connection with Janus closed`);
    });

    connection.once(Janode.EVENT.CONNECTION_ERROR, ({ message }) => {
      Logger.info(`${LOG_NS} connection with Janus error (${message})`);

      replyError(io, 'backend-failure');

      scheduleBackEndConnection();
    });

    const session = await connection.create();
    Logger.info(`${LOG_NS} session with Janus created`);
    janodeSession = session;

    session.once(Janode.EVENT.SESSION_DESTROYED, () => {
      Logger.info(`${LOG_NS} session destroyed`);
    });

    const handle = await session.attach(AudioBridgePlugin);
    Logger.info(`${LOG_NS} manager handle attached`);
    janodeManagerHandle = handle;

    // generic handle events
    handle.once(Janode.EVENT.HANDLE_DETACHED, () => {
      Logger.info(`${LOG_NS} manager handle detached`);
    });
  } catch (error) {
    Logger.error(`${LOG_NS} Janode setup error (${error.message})`);
    if (connection) connection.close().catch(() => { });

    // notify clients
    replyError(io, 'backend-failure');

    throw error;
  }
}

function initFrontEnd() {
  if (server.listening) return Promise.reject(new Error('Server already listening'));

  Logger.info(`${LOG_NS} initializing socketio front end...`);

  io.on('connection', function (socket) {
    const remote = `[${socket.request.connection.remoteAddress}:${socket.request.connection.remotePort}]`;
    Logger.info(`${LOG_NS} ${remote} connection with client established`);

    let audioHandle;

    /*----------*/
    /* USER API */
    /*----------*/

    socket.on('join', async (evtdata = {}) => {
      Logger.info(`${LOG_NS} ${remote} join received`);
      const { _id, data: joindata = {} } = evtdata;

      if (!checkSessions(janodeSession, true, socket, evtdata)) return;

      if (audioHandle) {
        Logger.verbose(`${LOG_NS} ${remote} detaching previous handle`);
        await audioHandle.detach().catch(() => { });
      }

      try {
        audioHandle = await janodeSession.attach(AudioBridgePlugin);
        Logger.info(`${LOG_NS} ${remote} audiobridge handle ${audioHandle.id} attached`);

        // custom audiobridge events
        audioHandle.once(AudioBridgePlugin.EVENT.AUDIOBRIDGE_DESTROYED, evtdata => {
          audioHandle.detach().catch(() => { });
          replyEvent(socket, 'destroyed', evtdata);
        });

        audioHandle.on(AudioBridgePlugin.EVENT.AUDIOBRIDGE_PEER_JOINED, evtdata => {
          replyEvent(socket, 'peer-joined', evtdata);
        });

        audioHandle.on(AudioBridgePlugin.EVENT.AUDIOBRIDGE_PEER_LEAVING, evtdata => {
          replyEvent(socket, 'peer-leaving', evtdata);
        });

        audioHandle.on(AudioBridgePlugin.EVENT.AUDIOBRIDGE_PEER_CONFIGURED, evtdata => {
          replyEvent(socket, 'peer-configured', evtdata);
        });

        audioHandle.on(AudioBridgePlugin.EVENT.AUDIOBRIDGE_KICKED, evtdata => {
          audioHandle.detach().catch(() => { });
          replyEvent(socket, 'kicked', evtdata);
        });

        audioHandle.on(AudioBridgePlugin.EVENT.AUDIOBRIDGE_PEER_KICKED, evtdata => {
          replyEvent(socket, 'peer-kicked', evtdata);
        });

        // generic audiobridge events
        audioHandle.on(Janode.EVENT.HANDLE_WEBRTCUP, () => Logger.info(`${LOG_NS} ${audioHandle.name} webrtcup event`));
        audioHandle.on(Janode.EVENT.HANDLE_MEDIA, evtdata => Logger.info(`${LOG_NS} ${audioHandle.name} media event ${JSON.stringify(evtdata)}`));
        audioHandle.on(Janode.EVENT.HANDLE_SLOWLINK, evtdata => Logger.info(`${LOG_NS} ${audioHandle.name} slowlink event ${JSON.stringify(evtdata)}`));
        audioHandle.on(Janode.EVENT.HANDLE_HANGUP, evtdata => Logger.info(`${LOG_NS} ${audioHandle.name} hangup event ${JSON.stringify(evtdata)}`));
        audioHandle.once(Janode.EVENT.HANDLE_DETACHED, () => {
          Logger.info(`${LOG_NS} ${audioHandle.name} detached event`);
        });

        const response = await audioHandle.join(joindata);

        replyEvent(socket, 'joined', response, _id);

        Logger.info(`${LOG_NS} ${remote} joined sent`);
      } catch ({ message }) {
        if (audioHandle) audioHandle.detach().catch(() => { });
        replyError(socket, message, joindata, _id);
      }
    });

    socket.on('configure', async (evtdata = {}) => {
      Logger.info(`${LOG_NS} ${remote} configure received`);
      const { _id, data: confdata = {} } = evtdata;

      if (!checkSessions(janodeSession, audioHandle, socket, evtdata)) return;

      try {
        const response = await audioHandle.configure(confdata);
        replyEvent(socket, 'configured', response, _id);
        Logger.info(`${LOG_NS} ${remote} configured sent`);
      } catch ({ message }) {
        replyError(socket, message, confdata, _id);
      }
    });

    socket.on('hangup', async (evtdata = {}) => {
      Logger.info(`${LOG_NS} ${remote} hangup received`);
      const { _id, data: hangupdata = {} } = evtdata;

      if (!checkSessions(janodeSession, audioHandle, socket, evtdata)) return;

      try {
        const response = await audioHandle.audioHangup();
        replyEvent(socket, 'hangingup', response, _id);
        Logger.info(`${LOG_NS} ${remote} hangingup sent`);
      } catch ({ message }) {
        replyError(socket, message, hangupdata, _id);
      }
    });

    socket.on('leave', async (evtdata = {}) => {
      Logger.info(`${LOG_NS} ${remote} leave received`);
      const { _id, data: leavedata = {} } = evtdata;

      if (!checkSessions(janodeSession, audioHandle, socket, evtdata)) return;

      try {
        const response = await audioHandle.leave();
        replyEvent(socket, 'leaving', response, _id);
        Logger.info(`${LOG_NS} ${remote} leaving sent`);
        audioHandle.detach().catch(() => { });
      } catch ({ message }) {
        replyError(socket, message, leavedata, _id);
      }
    });

    // trickle candidate from the client
    socket.on('trickle', async (evtdata = {}) => {
      Logger.info(`${LOG_NS} ${remote} trickle received`);
      const { _id, data: trickledata = {} } = evtdata;

      if (!checkSessions(janodeSession, audioHandle, socket, evtdata)) return;

      audioHandle.trickle(trickledata.candidate).catch(({ message }) => replyError(socket, message, trickledata, _id));
    });

    // trickle complete signal from the client
    socket.on('trickle-complete', async (evtdata = {}) => {
      Logger.info(`${LOG_NS} ${remote} trickle-complete received`);
      const { _id, data: trickledata = {} } = evtdata;

      if (!checkSessions(janodeSession, audioHandle, socket, evtdata)) return;

      audioHandle.trickleComplete().catch(({ message }) => replyError(socket, message, trickledata, _id));
    });

    // socket disconnection event
    socket.on('disconnect', () => {
      Logger.info(`${LOG_NS} ${remote} disconnected socket`);

      if (audioHandle) audioHandle.detach().catch(() => { });
    });

    /*----------------*/
    /* Management API */
    /*----------------*/

    socket.on('list-participants', async (evtdata = {}) => {
      Logger.info(`${LOG_NS} ${remote} list-participants received`);
      const { _id, data: listdata = {} } = evtdata;

      if (!checkSessions(janodeSession, janodeManagerHandle, socket, evtdata)) return;

      try {
        const response = await janodeManagerHandle.listParticipants(listdata);
        replyEvent(socket, 'participants-list', response, _id);
        Logger.info(`${LOG_NS} ${remote} participants-list sent`);
      } catch ({ message }) {
        replyError(socket, message, listdata, _id);
      }
    });

    socket.on('kick', async (evtdata = {}) => {
      Logger.info(`${LOG_NS} ${remote} kick received`);
      const { _id, data: kickdata = {} } = evtdata;

      if (!checkSessions(janodeSession, janodeManagerHandle, socket, evtdata)) return;

      try {
        const response = await janodeManagerHandle.kick(kickdata);
        replyEvent(socket, 'peer-kicked', response, _id);
        Logger.info(`${LOG_NS} ${remote} kicked sent`);
      } catch ({ message }) {
        replyError(socket, message, kickdata, _id);
      }
    });

    socket.on('exists', async (evtdata = {}) => {
      Logger.info(`${LOG_NS} ${remote} exists received`);
      const { _id, data: existsdata = {} } = evtdata;

      if (!checkSessions(janodeSession, janodeManagerHandle, socket, evtdata)) return;

      try {
        const response = await janodeManagerHandle.exists(existsdata);
        replyEvent(socket, 'exists', response, _id);
        Logger.info(`${LOG_NS} ${remote} exists sent`);
      } catch ({ message }) {
        replyError(socket, message, existsdata, _id);
      }
    });

    socket.on('list-rooms', async (evtdata = {}) => {
      Logger.info(`${LOG_NS} ${remote} list-rooms received`);
      const { _id, data: listdata = {} } = evtdata;

      if (!checkSessions(janodeSession, janodeManagerHandle, socket, evtdata)) return;

      try {
        const response = await janodeManagerHandle.list();
        replyEvent(socket, 'rooms-list', response, _id);
        Logger.info(`${LOG_NS} ${remote} rooms-list sent`);
      } catch ({ message }) {
        replyError(socket, message, listdata, _id);
      }
    });

    socket.on('create', async (evtdata = {}) => {
      Logger.info(`${LOG_NS} ${remote} create received`);
      const { _id, data: createdata = {} } = evtdata;

      if (!checkSessions(janodeSession, janodeManagerHandle, socket, evtdata)) return;

      try {
        const response = await janodeManagerHandle.create(createdata);
        replyEvent(socket, 'created', response, _id);
        Logger.info(`${LOG_NS} ${remote} created sent`);
      } catch ({ message }) {
        replyError(socket, message, createdata, _id);
      }
    });

    socket.on('destroy', async (evtdata = {}) => {
      Logger.info(`${LOG_NS} ${remote} destroy received`);
      const { _id, data: destroydata = {} } = evtdata;

      if (!checkSessions(janodeSession, janodeManagerHandle, socket, evtdata)) return;

      try {
        const response = await janodeManagerHandle.destroy(destroydata);
        replyEvent(socket, 'destroyed', response, _id);
        Logger.info(`${LOG_NS} ${remote} destroyed sent`);
      } catch ({ message }) {
        replyError(socket, message, destroydata, _id);
      }
    });

    socket.on('allow', async (evtdata = {}) => {
      Logger.info(`${LOG_NS} ${remote} allow received`);
      const { _id, data: allowdata = {} } = evtdata;

      if (!checkSessions(janodeSession, janodeManagerHandle, socket, evtdata)) return;

      try {
        const response = janodeManagerHandle.allow(allowdata);
        replyEvent(socket, 'allowed', response, _id);
        Logger.info(`${LOG_NS} ${remote} allowed sent`);
      } catch ({ message }) {
        replyError(socket, message, allowdata, _id);
      }
    });

    socket.on('rtp-fwd-start', async (evtdata = {}) => {
      Logger.info(`${LOG_NS} ${remote} rtp-fwd-start received`);
      const { _id, data: rtpstartdata = {} } = evtdata;

      if (!checkSessions(janodeSession, janodeManagerHandle, socket, evtdata)) return;

      try {
        const response = await janodeManagerHandle.startForward(rtpstartdata);
        replyEvent(socket, 'rtp-fwd-started', response, _id);
        Logger.info(`${LOG_NS} ${remote} rtp-fwd-started sent`);
      } catch ({ message }) {
        replyError(socket, message, rtpstartdata, _id);
      }
    });

    socket.on('rtp-fwd-stop', async (evtdata = {}) => {
      Logger.info(`${LOG_NS} ${remote} rtp-fwd-stop received`);
      const { _id, data: rtpstopdata = {} } = evtdata;

      if (!checkSessions(janodeSession, janodeManagerHandle, socket, evtdata)) return;

      try {
        const response = await janodeManagerHandle.stopForward(rtpstopdata);
        replyEvent(socket, 'rtp-fwd-stopped', response, _id);
        Logger.info(`${LOG_NS} ${remote} rtp-fwd-stopped sent`);
      } catch ({ message }) {
        replyError(socket, message, rtpstopdata, _id);
      }
    });

    socket.on('rtp-fwd-list', async (evtdata = {}) => {
      Logger.info(`${LOG_NS} ${remote} rtp-fwd-list received`);
      const { _id, data: rtplistdata = {} } = evtdata;

      if (!checkSessions(janodeSession, janodeManagerHandle, socket, evtdata)) return;

      try {
        const response = await janodeManagerHandle.listForward(rtplistdata);
        replyEvent(socket, 'rtp-fwd-list', response, _id);
        Logger.info(`${LOG_NS} ${remote} rtp-fwd-list sent`);
      } catch ({ message }) {
        replyError(socket, message, rtplistdata, _id);
      }
    });

  });

  // disable caching for all app
  app.set('etag', false).set('view cache', false);

  // static content
  app.use('/janode', express.static(__dirname + '/../html/', {
    etag: false,
    lastModified: false,
    maxAge: 0,
  }));

  // http server binding
  return new Promise((resolve, reject) => {
    // web server binding
    server.listen(
      serverConfig.port,
      serverConfig.bind,
      () => {
        Logger.info(`${LOG_NS} server listening on ${(options.key && options.cert) ? 'https' : 'http'}://${serverConfig.bind}:${serverConfig.port}/janode`);
        resolve();
      }
    );

    server.on('error', e => reject(e));
  });
}

function checkSessions(session, handle, socket, { data, _id }) {
  if (!session) {
    replyError(socket, 'session-not-available', data, _id);
    return false;
  }
  if (!handle) {
    replyError(socket, 'handle-not-available', data, _id);
    return false;
  }
  return true;
}

function replyEvent(socket, evtname, data, _id) {
  const evtdata = {
    data,
  };
  if (_id) evtdata._id = _id;

  socket.emit(evtname, evtdata);
}

function replyError(socket, message, request, _id) {
  const evtdata = {
    error: message,
  };
  if (request) evtdata.request = request;
  if (_id) evtdata._id = _id;

  socket.emit('audiobridge-error', evtdata);
}