'use strict';

/**
 * This module contains the implementation of the AudioBridge plugin (ref. {@link https://janus.conf.meetecho.com/docs/audiobridge.html}).
 * @module audiobridge-plugin
 */

const Handle = require('../handle.js');

/* The plugin ID exported in the plugin descriptor */
const PLUGIN_ID = 'janus.plugin.audiobridge';

/* These are the requests defined for the Janus AudioBridge API */
const REQUEST_JOIN = 'join';
const REQUEST_LIST_PARTICIPANTS = 'listparticipants';
const REQUEST_KICK = 'kick';
const REQUEST_CONFIGURE = 'configure';
const REQUEST_LEAVE = 'leave';
const REQUEST_AUDIO_HANGUP = 'hangup';
const REQUEST_EXISTS = 'exists';
const REQUEST_LIST_ROOMS = 'list';
const REQUEST_CREATE = 'create';
const REQUEST_DESTROY = 'destroy';
const REQUEST_ALLOW = 'allowed';
const REQUEST_RTP_FWD_START = 'rtp_forward';
const REQUEST_RTP_FWD_STOP = 'stop_rtp_forward';
const REQUEST_RTP_FWD_LIST = 'listforwarders';

/* These are the events/responses that the Janode plugin will manage */
/* Some of them will be exported in the plugin descriptor */
const PLUGIN_EVENT = {
  JOINED: 'audiobridge_joined',
  PEER_JOINED: 'audiobridge_peer_joined',
  PARTICIPANTS_LIST: 'audiobridge_participants_list',
  CONFIGURED: 'audiobridge_configured',
  PEER_CONFIGURED: 'audiobridge_peer_configured',
  LEAVING: 'audiobridge_leaving',
  AUDIO_HANGINGUP: 'audiobridge_hangingup',
  PEER_LEAVING: 'audiobridge_peer_leaving',
  KICKED: 'audiobridge_kicked',
  PEER_KICKED: 'audiobridge_peer_kicked',
  EXISTS: 'audiobridge_exists',
  ROOMS_LIST: 'audiobridge_list',
  CREATED: 'audiobridge_created',
  DESTROYED: 'audiobridge_destroyed',
  RTP_FWD: 'audiobridge_rtp_fwd',
  FWD_LIST: 'audiobridge_rtp_list',
  ALLOWED: 'audiobridge_allowed',
  SUCCESS: 'audiobridge_success',
  ERROR: 'audiobridge_error',
};

/**
 * The class implementing the AudioBridge plugin (ref. {@link https://janus.conf.meetecho.com/docs/audiobridge.html}).<br>
 *
 * It extends the base Janode Handle class and overrides the base "handleMessage" method.<br>
 *
 * Moreover it defines many methods to support AudioBridge operations.
 *
 * @hideconstructor
 */
class AudioBridgeHandle extends Handle {
  /**
   * Create a Janode AudioBridge handle.
   *
   * @param {module:session~Session} session - A reference to the parent session
   * @param {number} id - The handle identifier
   */
  constructor(session, id) {
    super(session, id);

    /**
     * The feed identifier assigned to this handle when it joined the audio bridge.
     *
     * @type {number|string}
     */
    this.feed = null;

    /**
     * The identifier of the room the audiobridge handle has joined.
     *
     * @type {number|string}
     */
    this.room = null;
  }

  /**
   * The custom "handleMessage" needed for handling AudioBridge messages.
   *
   * @private
   * @param {object} janus_message
   * @returns {object} A falsy value for unhandled events, a truthy value for handled events
   */
  handleMessage(janus_message) {
    const { plugindata, jsep, transaction } = janus_message;
    if (plugindata && plugindata.data && plugindata.data.audiobridge) {
      /**
       * @type {AudioBridgeData}
       */
      const message_data = plugindata.data;
      const { audiobridge, error, error_code, room } = message_data;

      /* Prepare an object for the output Janode event */
      const janode_event = {
        /* The name of the resolved event */
        event: null,
        /* The event payload */
        data: {},
      };

      /* Add JSEP data if available */
      if (jsep) janode_event.data.jsep = jsep;
      /* Add room information if available */
      if (room) janode_event.data.room = room;

      /* The plugin will emit an event only if the handle does not own the transaction */
      /* That means that a transaction has already been closed or this is an async event */
      const emit = (this.ownsTransaction(transaction) === false);

      /* Use the "janode" property to store the output event */
      janus_message._janode = janode_event;

      switch (audiobridge) {

        /* success response */
        case 'success':
          /* Room exists API */
          if (typeof message_data.exists !== 'undefined') {
            janode_event.data.exists = message_data.exists;
            janode_event.event = PLUGIN_EVENT.EXISTS;
            break;
          }
          /* Room list API */
          if (typeof message_data.list !== 'undefined') {
            janode_event.data.list = message_data.list;
            janode_event.event = PLUGIN_EVENT.ROOMS_LIST;
            break;
          }

          /* RTP forwarding started/stopped */
          if (typeof message_data.stream_id !== 'undefined') {
            janode_event.data.forwarder = {
              host: message_data.host,
              audio_port: message_data.port,
              audio_stream: message_data.stream_id,
            };
            /* Forwarding group info */
            if (message_data.group) janode_event.data.forwarder.group = message_data.group;
            janode_event.event = PLUGIN_EVENT.RTP_FWD;
            break;
          }

          /* Generic success (might be token disable) */
          if (typeof message_data.allowed !== 'undefined') {
            janode_event.data.list = message_data.allowed;
          }
          /* In this case the "event" field of the Janode event is "success" */
          janode_event.event = PLUGIN_EVENT.SUCCESS;
          break;

        /* Joined an audio bridge */
        case 'joined':
          /* If the message contains the id field, the event is for this handle */
          if (typeof message_data.id !== 'undefined') {
            /* Set the room, feed and display properties */
            this.room = room;
            this.feed = message_data.id;
            /* Set event data (feed, display name, setup, muted etc.) */
            janode_event.data.feed = message_data.id;
            if (typeof message_data.display === 'string') janode_event.data.display = message_data.display;
            if (typeof message_data.muted !== 'undefined') janode_event.data.muted = message_data.muted;
            if (typeof message_data.setup !== 'undefined') janode_event.data.setup = message_data.setup;
            if (typeof message_data.rtp !== 'undefined') janode_event.data.rtp = message_data.rtp;
            /* Add participants data */
            janode_event.data.participants = message_data.participants.map(({ id, display, muted, setup, rtp }) => {
              const peer = {
                feed: id,
                display,
                muted,
                setup,
                rtp,
              };
              return peer;
            });
            janode_event.event = PLUGIN_EVENT.JOINED;
          }
          /* If the event contains the participants field, this is the join of another peer */
          else if (message_data.participants && message_data.participants.length == 1) {
            janode_event.data.feed = message_data.participants[0].id;
            if (typeof message_data.participants[0].display === 'string') janode_event.data.display = message_data.participants[0].display;
            if (typeof message_data.participants[0].muted !== 'undefined') janode_event.data.muted = message_data.participants[0].muted;
            if (typeof message_data.participants[0].setup !== 'undefined') janode_event.data.setup = message_data.participants[0].setup;
            if (typeof message_data.participants[0].rtp !== 'undefined') janode_event.data.rtp = message_data.participants[0].rtp;
            janode_event.event = PLUGIN_EVENT.PEER_JOINED;
          }
          break;

        /* Participants list */
        case 'participants':
          janode_event.data.participants = message_data.participants.map(({ id, display, muted, setup, rtp }) => {
            const peer = {
              feed: id,
              display,
              muted,
              setup,
              rtp,
            };
            return peer;
          });
          janode_event.event = PLUGIN_EVENT.PARTICIPANTS_LIST;
          break;

        /* Audio bridge room created */
        case 'created':
          janode_event.event = PLUGIN_EVENT.CREATED;
          janode_event.data.permanent = message_data.permanent;
          break;

        /* Audio bridge room destroyed */
        case 'destroyed':
          janode_event.event = PLUGIN_EVENT.DESTROYED;
          break;

        /* Audio bridge explicit hangup (different from core hangup!) */
        case 'hangingup':
          janode_event.data.feed = message_data.id || this.feed;
          janode_event.event = PLUGIN_EVENT.AUDIO_HANGINGUP;
          break;

        /* This handle left the audio bridge */
        case 'left':
          janode_event.data.feed = message_data.id || this.feed;
          this.feed = null;
          this.room = null;
          janode_event.event = PLUGIN_EVENT.LEAVING;
          break;

        /* Active forwarders list */
        case 'forwarders':
          janode_event.data.forwarders = message_data.rtp_forwarders.map(({ ip, port, stream_id, always_on, group }) => {
            const forwarder = {
              host: ip,
              audio_port: port,
              audio_stream: stream_id,
              always: always_on,
            };
            if (group) forwarder.group = group;
            return forwarder;
          });
          janode_event.event = PLUGIN_EVENT.FWD_LIST;
          break;

        /* Generic event (e.g. errors) */
        case 'event':
          /* AudioBridge error */
          if (error) {
            janode_event.event = PLUGIN_EVENT.ERROR;
            janode_event.data = new Error(`${error_code} ${error}`);
            /* In case of error, close a transaction */
            this.closeTransactionWithError(transaction, janode_event.data);
            break;
          }
          /* Configuration success for this handle */
          if (typeof message_data.result !== 'undefined') {
            if (message_data.result === 'ok') {
              janode_event.event = PLUGIN_EVENT.CONFIGURED;
            }
            break;
          }
          /* Configuration events for other participants */
          if (typeof message_data.participants !== 'undefined' && message_data.participants.length == 1) {
            janode_event.data.feed = message_data.participants[0].id;
            if (typeof message_data.participants[0].display === 'string') janode_event.data.display = message_data.participants[0].display;
            if (typeof message_data.participants[0].muted !== 'undefined') janode_event.data.muted = message_data.participants[0].muted;
            if (typeof message_data.participants[0].setup !== 'undefined') janode_event.data.setup = message_data.participants[0].setup;
            janode_event.event = PLUGIN_EVENT.PEER_CONFIGURED;
            break;
          }
          /* Peer leaving confirmation */
          if (typeof message_data.leaving !== 'undefined') {
            janode_event.data.feed = message_data.leaving;
            janode_event.event = PLUGIN_EVENT.PEER_LEAVING;
            break;
          }
          /* This handle or another participant kicked-out */
          if (typeof message_data.kicked !== 'undefined') {
            janode_event.data.feed = message_data.kicked;
            if (this.feed === janode_event.data.feed) {
              /* Reset handle status */
              this.feed = null;
              this.room = null;
              janode_event.event = PLUGIN_EVENT.KICKED;
            }
            else {
              janode_event.event = PLUGIN_EVENT.PEER_KICKED;
            }
            break;
          }
      }

      /* The event has been handled */
      if (janode_event.event) {
        /* Try to close the transaction */
        this.closeTransactionWithSuccess(transaction, janus_message);
        /* If the transaction was not owned, emit the event */
        if (emit) this.emit(janode_event.event, janode_event.data);
        return janode_event;
      }
    }

    /* The event has not been handled, return a falsy value */
    return null;
  }

  /*----------*/
  /* USER API */
  /*----------*/

  /* These are the APIs that users need to work with the audiobridge plugin */

  /**
   * Join an audiobridge room.
   *
   * @param {object} params
   * @param {number|string} params.room - The room to join
   * @param {number} [params.feed=0] - The feed identifier for the participant, picked by Janus if omitted
   * @param {string} [params.display] - The display name to use
   * @param {boolean} [params.muted] - True to join in muted status
   * @param {string} [params.pin] - The pin needed to join
   * @param {string} [params.token] - The token to use when joining
   * @param {number} [params.quality] - The opus quality for the encoder
   * @param {number} [params.volume] - The percent volume
   * @param {boolean} [params.record] - True to enable recording
   * @param {string} [params.filename] - The recording filename
   * @param {module:audiobridge-plugin~RtpParticipant|boolean} [params.rtp_participant] - True if this feed is a plain RTP participant (use an object to pass a participant descriptor)
   * @param {string} [params.group] - The group to assign to this participant
   * @returns {Promise<module:audiobridge-plugin~AUDIOBRIDGE_EVENT_JOINED>}
   */
  async join({ room, feed = 0, display, muted, pin, token, quality, volume, record, filename, rtp_participant, group }) {
    const body = {
      request: REQUEST_JOIN,
      room,
      id: feed,
    };
    if (typeof display === 'string') body.display = display;
    if (typeof muted === 'boolean') body.muted = muted;
    if (typeof pin === 'string') body.pin = pin;
    if (typeof token === 'string') body.token = token;
    if (typeof quality === 'number') body.quality = quality;
    if (typeof volume === 'number') body.volume = volume;
    if (typeof record === 'boolean') body.record = record;
    if (typeof filename === 'string') body.filename = filename;
    if (typeof rtp_participant === 'object' && rtp_participant) body.rtp = rtp_participant;
    else if (typeof rtp_participant === 'boolean' && rtp_participant) body.rtp = {};
    if (typeof group === 'string') body.group = group;

    const response = await this.message(body);
    const { event, data: evtdata } = response._janode || {};
    if (event === PLUGIN_EVENT.JOINED)
      return evtdata;
    const error = new Error(`unexpected response to ${body.request} request`);
    throw (error);
  }

  /**
   * Configure an audiobridge handle.
   *
   * @param {object} params
   * @param {string} [params.display] - The display name to use
   * @param {boolean} [params.muted] - Set muted status
   * @param {number} [params.quality] - Set opus quality
   * @param {number} [params.volume] - Set volume percent
   * @param {boolean} [params.record] - Enable recording
   * @param {string} [params.filename] - Set recording filename
   * @param {number} [params.prebuffer] - Set a new prebuffer value
   * @param {string} [params.group] - Set the group that the participant belongs to
   * @param {RTCSessionDescription} [params.jsep=null] - JSEP offer
   * @returns {Promise<module:audiobridge-plugin~AUDIOBRIDGE_EVENT_CONFIGURED>}
   */
  async configure({ display, muted, quality, volume, record, filename, prebuffer, group, jsep = null }) {
    const body = {
      request: REQUEST_CONFIGURE,
    };
    if (typeof display === 'string') body.display = display;
    if (typeof muted === 'boolean') body.muted = muted;
    if (typeof quality === 'number') body.quality = quality;
    if (typeof volume === 'number') body.volume = volume;
    if (typeof record === 'boolean') body.record = record;
    if (typeof filename === 'string') body.filename = filename;
    if (typeof prebuffer === 'number') body.prebuffer = prebuffer;
    if (typeof group === 'string') body.group = group;

    const response = await this.message(body, jsep);
    const { event, data: evtdata } = response._janode || {};
    if (event === PLUGIN_EVENT.CONFIGURED) {
      /* Janus does not reply with configured data, so we need to re-use the requested configuration */
      /* Use feed and room from handle status */
      evtdata.feed = this.feed;
      evtdata.room = this.room;
      if (typeof body.display !== 'undefined') evtdata.display = body.display;
      if (typeof body.muted !== 'undefined') evtdata.muted = body.muted;
      if (typeof body.quality !== 'undefined') evtdata.quality = body.quality;
      if (typeof body.volume !== 'undefined') evtdata.volume = body.volume;
      if (typeof body.record !== 'undefined') evtdata.record = body.record;
      if (typeof body.filename !== 'undefined') evtdata.filename = body.filename;
      if (typeof body.prebuffer !== 'undefined') evtdata.prebuffer = body.prebuffer;
      if (typeof body.group !== 'undefined') evtdata.group = body.group;
      return evtdata;
    }
    const error = new Error(`unexpected response to ${body.request} request`);
    throw (error);
  }

  /**
   * Request an audiobridge handle hangup.
   *
   * @returns {Promise<module:audiobridge-plugin~AUDIOBRIDGE_EVENT_AUDIO_HANGINGUP>}
   *
   */
  async audioHangup() {
    const body = {
      request: REQUEST_AUDIO_HANGUP,
    };

    const response = await this.message(body);
    const { event, data: evtdata } = response._janode || {};
    if (event === PLUGIN_EVENT.AUDIO_HANGINGUP)
      return evtdata;
    const error = new Error(`unexpected response to ${body.request} request`);
    throw (error);
  }

  /**
   * Leave an audiobridge room.
   *
   * @returns {Promise<module:audiobridge-plugin~AUDIOBRIDGE_EVENT_LEAVING>}
   */
  async leave() {
    const body = {
      request: REQUEST_LEAVE,
    };

    const response = await this.message(body);
    const { event, data: evtdata } = response._janode || {};
    if (event === PLUGIN_EVENT.LEAVING)
      return evtdata;
    const error = new Error(`unexpected response to ${body.request} request`);
    throw (error);
  }

  /*----------------*/
  /* Management API */
  /*----------------*/

  /* These are the APIs needed to manage audiobridge resources (rooms, forwarders ...) */

  /**
   * List participants inside a room.
   *
   * @param {object} params
   * @param {number|string} params.room - The room where to execute the list
   * @param {string} [params.secret] - The optional secret needed for managing the room
   * @returns {Promise<module:audiobridge-plugin~AUDIOBRIDGE_EVENT_PARTICIPANTS_LIST>}
   */
  async listParticipants({ room, secret }) {
    const body = {
      request: REQUEST_LIST_PARTICIPANTS,
      room,
    };
    if (typeof secret === 'string') body.secret = secret;

    const response = await this.message(body);
    const { event, data: evtdata } = response._janode || {};
    if (event === PLUGIN_EVENT.PARTICIPANTS_LIST)
      return evtdata;
    const error = new Error(`unexpected response to ${body.request} request`);
    throw (error);
  }

  /**
   * Kick an user out from a room.
   *
   * @param {object} params
   * @param {number|string} params.room - The involved room
   * @param {number|string} params.feed - The feed to kick out
   * @param {string} [params.secret] - The optional secret needed for managing the room
   * @returns {Promise<module:audiobridge-plugin~AUDIOBRIDGE_EVENT_KICK_RESPONSE>}
   */
  async kick({ room, feed, secret }) {
    const body = {
      request: REQUEST_KICK,
      room,
      id: feed,
    };
    if (typeof secret === 'string') body.secret = secret;

    const response = await this.message(body);
    const { event, data: evtdata } = response._janode || {};
    if (event === PLUGIN_EVENT.SUCCESS) {
      /* Add data missing from Janus response */
      evtdata.room = body.room;
      evtdata.feed = body.id;
      return evtdata;
    }
    const error = new Error(`unexpected response to ${body.request} request`);
    throw (error);
  }

  /**
   * Check if a room exists.
   *
   * @param {object} params
   * @param {number|string} params.room - The involved room
   * @returns {Promise<module:audiobridge-plugin~AUDIOBRIDGE_EVENT_EXISTS>}
   */
  async exists({ room }) {
    const body = {
      request: REQUEST_EXISTS,
      room,
    };

    const response = await this.message(body);
    const { event, data: evtdata } = response._janode || {};
    if (event === PLUGIN_EVENT.EXISTS)
      return evtdata;
    const error = new Error(`unexpected response to ${body.request} request`);
    throw (error);
  }

  /**
   * List available audiobridge rooms.
   *
   * @returns {Promise<module:audiobridge-plugin~AUDIOBRIDGE_EVENT_ROOMS_LIST>}
   */
  async list() {
    const body = {
      request: REQUEST_LIST_ROOMS,
    };

    const response = await this.message(body);
    const { event, data: evtdata } = response._janode || {};
    if (event === PLUGIN_EVENT.ROOMS_LIST)
      return evtdata;
    const error = new Error(`unexpected response to ${body.request} request`);
    throw (error);
  }

  /**
   * Create an audiobridge room.
   *
   * @param {object} params
   * @param {number|string} params.room - The room identifier
   * @param {string} [params.description] - A room description
   * @param {boolean} [params.permanent] - Set to true to persist the room in the Janus config file
   * @param {number} [params.sampling_rate] - The sampling rate (bps) to be used in the room
   * @param {boolean} [params.is_private] - Set room as private (hidden in list)
   * @param {string} [params.secret] - The secret to be used when managing the room
   * @param {string} [params.pin] - The ping needed for joining the room
   * @param {boolean} [params.record] - True to record the mixed audio
   * @param {string} [params.filename] - The recording filename
   * @param {number} [params.prebuffer] - The prebuffer to use for every participant
   * @param {boolean} [params.allow_rtp] - Allow plain RTP participants
   * @param {string[]} [params.groups] - The available groups in the room
   * @returns {Promise<module:audiobridge-plugin~AUDIOBRIDGE_EVENT_CREATED>}
   */
  async create({ room, description, permanent, sampling_rate, is_private, secret, pin, record, filename, prebuffer, allow_rtp, groups }) {
    const body = {
      request: REQUEST_CREATE,
      room,
    };
    if (typeof description === 'string') body.description = description;
    if (typeof permanent === 'boolean') body.permanent = permanent;
    if (typeof sampling_rate === 'number') body.sampling = sampling_rate;
    if (typeof is_private === 'boolean') body.is_private = is_private;
    if (typeof secret === 'string') body.secret = secret;
    if (typeof pin === 'string') body.pin = pin;
    if (typeof record === 'boolean') body.record = record;
    if (typeof filename === 'string') body.record_file = filename;
    if (typeof prebuffer === 'number') body.default_prebuffering = prebuffer;
    if (typeof allow_rtp === 'boolean') body.allow_rtp_participants = allow_rtp;
    if (Array.isArray(groups)) body.groups = groups;

    const response = await this.message(body);
    const { event, data: evtdata } = response._janode || {};
    if (event === PLUGIN_EVENT.CREATED)
      return evtdata;
    const error = new Error(`unexpected response to ${body.request} request`);
    throw (error);
  }

  /**
   * Destroy an audiobridge room.
   *
   * @param {object} params
   * @param {number|string} params.room - The room to destroy
   * @param {boolean} [params.permanent] - Set to true to remove the room from the Janus config file
   * @param {string} [params.secret] - The optional secret needed to manage the room
   * @returns {Promise<module:audiobridge-plugin~AUDIOBRIDGE_EVENT_DESTROYED>}
   */
  async destroy({ room, permanent, secret }) {
    const body = {
      request: REQUEST_DESTROY,
      room,
    };
    if (typeof permanent === 'boolean') body.permanent = permanent;
    if (typeof secret === 'string') body.secret = secret;

    const response = await this.message(body);
    const { event, data: evtdata } = response._janode || {};
    if (event === PLUGIN_EVENT.DESTROYED)
      return evtdata;
    const error = new Error(`unexpected response to ${body.request} request`);
    throw (error);
  }

  /**
   * Edit an audiobridge token list.
   *
   * @param {object} params
   * @param {number|string} params.room - The involved room
   * @param {"enable"|"disable"|"add"|"remove"} params.action - The action to perform
   * @param {string[]} params.list - The list of tokens to add/remove
   * @param {string} [params.secret] - The optional secret needed to manage the room
   * @returns {Promise<module:audiobridge-plugin~AUDIOBRIDGE_EVENT_ALLOWED>}
   */
  async allow({ room, action, list, secret }) {
    const body = {
      request: REQUEST_ALLOW,
      room,
      action,
    };
    if (list && list.length > 0) body.allowed = list;
    if (typeof secret === 'string') body.secret = secret;

    const response = await this.message(body);
    const { event, data: evtdata } = response._janode || {};
    if (event === PLUGIN_EVENT.SUCCESS)
      return evtdata;
    const error = new Error(`unexpected response to ${body.request} request`);
    throw (error);
  }

  /**
   * Start a RTP forwarder.
   *
   * @param {object} params
   * @param {number|string} params.room - The involved room
   * @param {boolean} [params.always] - Whether silence should be forwarded when the room is empty
   * @param {string} params.host - The host to forward to
   * @param {number} params.audio_port - The port to forward to
   * @param {string} [params.group] - The group to forward
   * @param {string} [params.secret] - The optional secret needed to manage the room
   * @returns {Promise<module:audiobridge-plugin~AUDIOBRIDGE_EVENT_RTP_FWD>}
   */
  async startForward({ room, always, host, audio_port, group, secret }) {
    const body = {
      request: REQUEST_RTP_FWD_START,
      room,
    };
    if (typeof always === 'boolean') body.always_on = always;
    if (typeof host === 'string') body.host = host;
    if (typeof audio_port === 'number') body.port = audio_port;
    if (typeof group === 'string') body.group = group;
    if (typeof secret === 'string') body.secret = secret;

    const response = await this.message(body);
    const { event, data: evtdata } = response._janode || {};
    if (event === PLUGIN_EVENT.RTP_FWD)
      return evtdata;
    const error = new Error(`unexpected response to ${body.request} request`);
    throw (error);
  }

  /**
   * Stop a RTP forwarder.
   *
   * @param {object} params
   * @param {number|string} params.room - The involved room
   * @param {number} params.stream - The forwarder identifier to stop
   * @param {string} [params.secret] - The optional secret needed to manage the room
   * @returns {Promise<module:audiobridge-plugin~AUDIOBRIDGE_EVENT_RTP_FWD>}
   */
  async stopForward({ room, stream, secret }) {
    const body = {
      request: REQUEST_RTP_FWD_STOP,
      room,
      stream_id: stream,
    };
    if (typeof secret === 'string') body.secret = secret;

    const response = await this.message(body);
    const { event, data: evtdata } = response._janode || {};
    if (event === PLUGIN_EVENT.RTP_FWD)
      return evtdata;
    const error = new Error(`unexpected response to ${body.request} request`);
    throw (error);
  }

  /**
   * List active forwarders.
   *
   * @param {object} params
   * @param {number|string} params.room - The involved room
   * @param {string} [params.secret] - The optional secret needed to manage the room
   * @returns {Promise<module:audiobridge-plugin~AUDIOBRIDGE_EVENT_FWD_LIST>}
   */
  async listForward({ room, secret }) {
    const body = {
      request: REQUEST_RTP_FWD_LIST,
      room,
    };
    if (typeof secret === 'string') body.secret = secret;

    const response = await this.message(body);
    const { event, data: evtdata } = response._janode || {};
    if (event === PLUGIN_EVENT.FWD_LIST)
      return evtdata;
    const error = new Error(`unexpected response to ${body.request} request`);
    throw (error);
  }

}

/**
 * The payload of the plugin message (cfr. Janus docs).
 * {@link https://janus.conf.meetecho.com/docs/audiobridge.html}
 *
 * @private
 * @typedef {object} AudioBridgeData
 */

/**
 * @typedef {object} RtpParticipant
 * @property {string} ip - IP address you want media to be sent to
 * @property {number} port - The port you want media to be sent to
 * @property {number} payload_type - The payload type to use for RTP packets
 */

/**
 * The response event to a join request.
 *
 * @typedef {object} AUDIOBRIDGE_EVENT_JOINED
 * @property {number|string} room - The involved room
 * @property {number|string} feed - The feed identifier
 * @property {string} [display] - The display name, if available
 * @property {boolean} [muted] - True if the user joind in muted state
 * @property {boolean} [setup] - True if the Peer Connection has been established
 * @property {module:audiobridge-plugin~RtpParticipant} [rtp] - True if the peer is a plain RTP participant
 */

/**
 * The response event for configure request.
 *
 * @typedef {object} AUDIOBRIDGE_EVENT_CONFIGURED
 * @property {number|string} room - The involved room
 * @property {number|string} feed - The feed identifier
 * @property {string} [display] - The display name, if available
 * @property {boolean} [muted] - The muted status
 * @property {number} [quality] - [0-10] Opus-related complexity to use
 * @property {number} [volume] - Volume percent value
 * @property {boolean} [record] - True if recording is active for this feed
 * @property {string} [filename] - The recording filename
 * @property {number} [prebuffer] - Number of packets to buffer before decoding
 * @property {string} [group] - Group to assign to this participant
 * @property {RTCSessionDescription} [jsep] - The JSEP answer
 */

/**
 * The response event for audiobridge hangup request.
 *
 * @typedef {object} AUDIOBRIDGE_EVENT_AUDIO_HANGINGUP
 * @property {number|string} room - The involved room
 * @property {number|string} feed - The feed that is being hung up
 */

/**
 * The response event for audiobridge leave request.
 *
 * @typedef {object} AUDIOBRIDGE_EVENT_LEAVING
 * @property {number|string} room - The involved room
 * @property {number|string} feed- The feed that is leaving
 */

/**
 * The response event for audiobridge participants list request.
 *
 * @typedef {object} AUDIOBRIDGE_EVENT_PARTICIPANTS_LIST
 * @property {number|string} room - The involved room
 * @property {object[]} participants - The list of participants
 * @property {number|string} participants[].feed - The participant feed identifier
 * @property {string} [participants[].display] - The participant display name
 * @property {boolean} [participants[].muted] - The muted status of the participant
 * @property {boolean} [participants[].setup] - True if participant PeerConnection is up
 */

/**
 * The response event for audiobridge participant kick request.
 *
 * @typedef {object} AUDIOBRIDGE_EVENT_KICK_RESPONSE
 * @property {number|string} room - The involved room
 * @property {number|string} feed - The feed that has been kicked out
 */

/**
 * The response event for audiobridge room exists request.
 *
 * @typedef {object} AUDIOBRIDGE_EVENT_EXISTS
 * @property {number|string} room - The involved room
 * @property {boolean} exists - True if the rooms exists
 */

/**
 * The response event for audiobridge room list request.
 *
 * @typedef {object} AUDIOBRIDGE_EVENT_ROOMS_LIST
 * @property {object[]} list - The list of the rooms as returned by Janus
 */

/**
 * The response event for audiobridge forwarder start request.
 *
 * @typedef {object} AUDIOBRIDGE_EVENT_RTP_FWD
 * @property {number|string} room - The involved room
 * @property {object} forwarder - Forwarder descriptor
 * @property {string} forwarder.host - The target host
 * @property {number} forwarder.audio_port - The target port
 * @property {number} forwarder.audio_stream - The identifier of the forwarder
 * @property {string} [forwarder.group] - The group that is being forwarded
 */

/**
 * The response event for audiobridge room create request.
 *
 * @typedef {object} AUDIOBRIDGE_EVENT_CREATED
 * @property {number|string} room - The created room
 * @property {boolean} permanent - True if the room is being persisted in the Janus config file
 */

/**
 * The response event for audiobridge room destroy request.
 *
 * @typedef {object} AUDIOBRIDGE_EVENT_DESTROYED
 * @property {number|string} room - The destroyed room
 */

/**
 * The response event for audiobridge forwarders list request.
 *
 * @typedef {object} AUDIOBRIDGE_EVENT_FWD_LIST
 * @property {number|string} room - The involved room
 * @property {object[]} forwarders - The list of forwarders
 * @property {string} forwarders[].host - The target host
 * @property {number} forwarders[].audio_port - The target port
 * @property {number} forwarders[].audio_stream - The forwarder identifier
 * @property {boolean} forwarders[].always - Whether this forwarder works even when no participant is in or not
 * @property {string} [forwarders[].group] - The group that is being forwarded
 */

/**
 * The response event for audiobridge ACL token edit request.
 *
 * @typedef {object} AUDIOBRIDGE_EVENT_ALLOWED
 * @property {number|string} room - The involved room
 * @property {string[]} list - The updated, complete, list of allowed tokens
 */

/**
 * The exported plugin descriptor.
 *
 * @type {object}
 * @property {string} id - The plugin identifier used when attaching to Janus
 * @property {module:audiobridge-plugin~AudioBridgeHandle} Handle - The custom class implementing the plugin
 * @property {object} EVENT - The events emitted by the plugin
 * @property {string} EVENT.AUDIOBRIDGE_DESTROYED {@link module:audiobridge-plugin~AUDIOBRIDGE_DESTROYED}
 * @property {string} EVENT.AUDIOBRIDGE_KICKED - {@link module:audiobridge-plugin~AUDIOBRIDGE_KICKED}
 * @property {string} EVENT.AUDIOBRIDGE_PEER_JOINED {@link module:audiobridge-plugin~AUDIOBRIDGE_PEER_JOINED}
 * @property {string} EVENT.AUDIOBRIDGE_PEER_CONFIGURED {@link module:audiobridge-plugin~AUDIOBRIDGE_PEER_CONFIGURED}
 * @property {string} EVENT.AUDIOBRIDGE_PEER_KICKED {@link module:audiobridge-plugin~AUDIOBRIDGE_PEER_KICKED}
 * @property {string} EVENT.AUDIOBRIDGE_PEER_LEAVING {@link module:audiobridge-plugin~AUDIOBRIDGE_PEER_LEAVING}
 * @property {string} EVENT.AUDIOBRIDGE_ERROR {@link module:audiobridge-plugin~AUDIOBRIDGE_ERROR}
 */
module.exports = {
  id: PLUGIN_ID,
  Handle: AudioBridgeHandle,

  EVENT: {
    /**
     * The audiobridge room has been destroyed.
     *
     * @event module:audiobridge-plugin~AudioBridgeHandle#event:AUDIOBRIDGE_DESTROYED
     * @type {module:audiobridge-plugin~AUDIOBRIDGE_EVENT_DESTROYED}
     */
    AUDIOBRIDGE_DESTROYED: PLUGIN_EVENT.DESTROYED,

    /**
     * The current user has been kicked out.
     *
     * @event module:audiobridge-plugin~AudioBridgeHandle#event:AUDIOBRIDGE_KICKED
     * @type {object}
     * @property {number|string} room
     * @property {number|string} feed
     */
    AUDIOBRIDGE_KICKED: PLUGIN_EVENT.KICKED,

    /**
     * A new participant joined.
     *
     * @event module:audiobridge-plugin~AudioBridgeHandle#event:AUDIOBRIDGE_PEER_JOINED
     * @type {object}
     * @property {number|string} room
     * @property {number|string} feed
     * @property {string} [display]
     * @property {boolean} [muted]
     * @property {boolean} [setup]
     * @property {object} [rtp]
     */
    AUDIOBRIDGE_PEER_JOINED: PLUGIN_EVENT.PEER_JOINED,

    /**
     * A participant has been configured.
     *
     * @event module:audiobridge-plugin~AudioBridgeHandle#event:AUDIOBRIDGE_PEER_CONFIGURED
     * @type {object}
     * @property {number|string} room
     * @property {number|string} feed
     * @property {string} [display]
     * @property {boolean} [muted]
     * @property {boolean} [setup]
     */
    AUDIOBRIDGE_PEER_CONFIGURED: PLUGIN_EVENT.PEER_CONFIGURED,

    /**
     * A participant has been kicked out.
     *
     * @event module:audiobridge-plugin~AudioBridgeHandle#event:AUDIOBRIDGE_PEER_KICKED
     * @type {object}
     * @property {number|string} room
     * @property {number|string} feed
     */
    AUDIOBRIDGE_PEER_KICKED: PLUGIN_EVENT.PEER_KICKED,

    /**
     * A participant is leaving.
     *
     * @event module:audiobridge-plugin~AudioBridgeHandle#event:AUDIOBRIDGE_PEER_LEAVING
     * @type {object}
     * @property {number|string} room
     * @property {number|string} feed
     */
    AUDIOBRIDGE_PEER_LEAVING: PLUGIN_EVENT.PEER_LEAVING,

    /**
     * Generic audiobridge error.
     *
     * @event module:audiobridge-plugin~AudioBridgeHandle#event:AUDIOBRIDGE_ERROR
     * @type {Error}
     */
    AUDIOBRIDGE_ERROR: PLUGIN_EVENT.ERROR,
  },
};