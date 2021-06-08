const ytsr = require("@distube/ytsr"),
  ytpl = require("@distube/ytpl"),
  { EventEmitter } = require("events"),
  Discord = require("discord.js"),
  DisTubeOption = require("./core/DisTubeOptions"),
  DisTubeHandler = require("./core/DisTubeHandler"),
  Queue = require("./struct/Queue"),
  SearchResult = require("./struct/SearchResult"),
  Song = require("./struct/Song"),
  Playlist = require("./struct/Playlist"),
  Plugin = require("./struct/Plugin"),
  CustomPlugin = require("./struct/CustomPlugin"),
  ExtractorPlugin = require("./struct/ExtractorPlugin");

/**
 * FFmpeg Filters
 * ```
 * {
 *   "Filter Name": "Filter Value",
 *   "bassboost":   "bass=g=10"
 * }
 * ```
 * @typedef {Object.<string, string>} Filters
 * @see {@link DefaultFilters}
 */

/**
 * Data that resolves to give a {@link Queue} object. This can be:
 * - A {@link Queue}
 * - A guild ID string
 * - A {@link https://discord.js.org/#/docs/main/master/class/Snowflake|Snowflake}
 * - A {@link https://discord.js.org/#/docs/main/master/class/Message|Message}
 * - A {@link https://discord.js.org/#/docs/main/master/class/VoiceChannel|VoiceChannel}
 * - A {@link https://discord.js.org/#/docs/main/master/class/StageChannel|StageChannel}
 * - A {@link https://discord.js.org/#/docs/main/master/class/VoiceState|VoiceState}
 * @typedef {Queue|Discord.Snowflake|Discord.Message|Discord.VoiceChannel|Discord.StageChannel|Discord.VoiceState|string} QueueResolvable
 */

/**
 * DisTube options.
 * @typedef {Object} DisTubeOptions
 * @prop {Array<Plugin>} [plugins] DisTube plugins.
 * @prop {boolean} [emitNewSongOnly=false] If `true`, {@link DisTube#event:playSong} will not be emitted when looping a song or next song is the same as the previous one
 * @prop {boolean} [leaveOnEmpty=true] Whether or not leaving voice channel if the voice channel is empty after {@link DisTubeOptions}.emptyCooldown seconds.
 * @prop {boolean} [leaveOnFinish=false] Whether or not leaving voice channel when the queue ends.
 * @prop {boolean} [leaveOnStop=true] Whether or not leaving voice channel after using {@link DisTube#stop|stop()} function.
 * @prop {boolean} [savePreviousSongs=true] Whether or not saving the previous songs of the queue and enable {@link DisTube#previous|previous()} method
 * @prop {number} [searchSongs=0] Limit of search results emits in {@link DisTube#event:searchResult} event when {@link DisTube#play|play()} method executed. If `searchSongs <= 1`, play the first result
 * @prop {string} [youtubeCookie=null] YouTube cookies. Read how to get it in {@link https://github.com/fent/node-ytdl-core/blob/997efdd5dd9063363f6ef668bb364e83970756e7/example/cookies.js#L6-L12|YTDL's Example}
 * @prop {string} [youtubeIdentityToken=null] If not given; ytdl-core will try to find it. You can find this by going to a video's watch page; viewing the source; and searching for "ID_TOKEN".
 * @prop {boolean} [youtubeDL=true] Whether or not using youtube-dl.
 * @prop {boolean} [updateYouTubeDL=true] Whether or not updating youtube-dl automatically.
 * @prop {Filters} [customFilters] Override {@link DefaultFilters} or add more ffmpeg filters. Example=`{ "Filter name"="Filter value"; "8d"="apulsator=hz=0.075" }`
 * @prop {Object} [ytdlOptions] `ytdl-core` options
 * @prop {number} [searchCooldown=60] Built-in search cooldown in seconds (When searchSongs is bigger than 0)
 * @prop {number} [emptyCooldown=60] Built-in leave on empty cooldown in seconds (When leaveOnEmpty is true)
 * @prop {boolean} [nsfw=false] Whether or not playing age-restricted content and disabling safe search in non-NSFW channel.
 */

/**
 * DisTube class
 * @extends EventEmitter
 */
class DisTube extends EventEmitter {
  /**
   * DisTube's current version.
   * @type {string}
   */
  get version() { return require("../package.json").version }
  static get version() { return require("../package.json").version }
  /**
   * Create a new DisTube class.
   * @param {Discord.Client} client Discord.JS client
   * @param {DisTubeOptions} [otp] Custom DisTube options
   * @example
   * const Discord = require('discord.js'),
   *     DisTube = require('distube'),
   *     client = new Discord.Client();
   * // Create a new DisTube
   * const distube = new DisTube(client, { searchSongs: 10 });
   * // client.DisTube = distube // make it access easily
   * client.login("Your Discord Bot Token")
   */
  constructor(client, otp = {}) {
    super();
    if (!client || typeof client.user === "undefined") throw new TypeError("Invalid Discord.Client");

    /**
     * Discord.JS client
     * @type {Discord.Client}
     */
    this.client = client;

    /**
     * Collection of guild queues
     * @type {Discord.Collection<string, Queue>}
     */
    this.guildQueues = new Discord.Collection();

    /**
     * DisTube options
     * @type {DisTubeOptions}
     */
    this.options = new DisTubeOption(otp);

    /**
     * DisTube's Handler
     * @type {DisTubeHandler}
     * @private
     */
    this.handler = new DisTubeHandler(this);

    /**
     * DisTube filters
     * @type {Filters}
     */
    this.filters = require("./struct/Filter");
    if (typeof this.options.customFilters === "object") Object.assign(this.filters, this.options.customFilters);

    if (this.options.leaveOnEmpty) {
      client.on("voiceStateUpdate", oldState => {
        if (!oldState?.channel) return;
        const queue = this.getQueue(oldState);
        if (!queue) {
          if (this.handler.isVoiceChannelEmpty(oldState)) {
            client.setTimeout(() => {
              if (!this.getQueue(oldState) && this.handler.isVoiceChannelEmpty(oldState)) oldState.guild.me?.voice?.channel?.leave();
            }, this.options.emptyCooldown * 1000);
          }
          return;
        }
        if (queue.emptyTimeout) {
          client.clearTimeout(queue.emptyTimeout);
          queue.emptyTimeout = null;
        }
        if (this.handler.isVoiceChannelEmpty(oldState)) {
          queue.emptyTimeout = client.setTimeout(() => {
            if (this.handler.isVoiceChannelEmpty(oldState)) {
              oldState.guild.me?.voice?.channel?.leave();
              this.emit("empty", queue);
              queue.stop();
            }
          }, this.options.emptyCooldown * 1000);
        }
      });
    }

    // Default plugin
    const HTTPPlugin = require("./plugins/http"),
      HTTPSPlugin = require("./plugins/https");
    this.options.plugins.push(new HTTPPlugin(), new HTTPSPlugin());
    if (this.options.youtubeDL) {
      const YouTubeDLPlugin = require("./plugins/youtube-dl");
      this.options.plugins.push(new YouTubeDLPlugin(this.options.updateYouTubeDL));
    }
    this.options.plugins.map(p => p.init(this));
    /**
     * Extractor Plugins
     * @type {Array<ExtractorPlugin>}
     * @private
     */
    this.extractorPlugins = this.options.plugins.filter(p => p.type === "extractor");
    /**
     * Custom Plugins
     * @type {Array<CustomPlugin>}
     * @private
     */
    this.customPlugins = this.options.plugins.filter(p => p.type === "custom");
  }

  /**
   * Shorthand method for {@link DisTube#playVoiceChannel}
   * @returns {Promise<void>}
   * @param {Discord.Message} message A message from guild channel
   * @param {string|Song|SearchResult|Playlist} song YouTube url | Search string | {@link Song} | {@link SearchResult} | {@link Playlist}
   * @param {Object} [options] Optional options
   * @param {boolean} [options.skip=false] Skip the playing song (if exists) and play the added song/playlist instantly
   * @param {boolean} [options.unshift=false] Add the song/playlist to the beginning of the queue (after the playing song if exists)
   * @example
   * client.on('message', (message) => {
   *     if (!message.content.startsWith(config.prefix)) return;
   *     const args = message.content.slice(config.prefix.length).trim().split(/ +/g);
   *     const command = args.shift();
   *     if (command == "play")
   *         distube.play(message, args.join(" "));
   * });
   */
  async play(message, song, options = {}) {
    if (!song) return;
    if (!(message instanceof Discord.Message)) throw new TypeError("message is not a Discord.Message.");
    if (typeof options !== "object" || Array.isArray(options)) {
      throw new TypeError("options must be an object.");
    }
    try {
      const { skip, unshift } = Object.assign({ skip: false, unshift: false }, options);
      const voiceChannel = message.member.voice.channel;
      if (!voiceChannel) throw new Error("User is not in any voice channel.");
      await this.playVoiceChannel(voiceChannel, song, {
        member: message.member,
        textChannel: message.channel,
        skip,
        message,
        unshift,
      });
    } catch (e) {
      try {
        e.name = "PlayError";
        e.message = `${song?.url || song}\n${e.message}`;
      } catch { }
      this.emitError(message.channel, e);
    }
  }

  /**
   * Play / add a song or playlist from url. Search and play a song if it is not a valid url.
   * Emit {@link DisTube#addList}, {@link DisTube#addSong} or {@link DisTube#playSong} after executing
   * @returns {Promise<void>}
   * @param {Discord.VoiceChannel|Discord.StageChannel} voiceChannel The voice channel will be joined
   * @param {string|Song|SearchResult|Playlist} song YouTube url | Search string | {@link Song} | {@link SearchResult} | {@link Playlist}
   * @param {Object} [options] Optional options
   * @param {boolean} [options.skip=false] Skip the playing song (if exists) and play the added song/playlist instantly
   * @param {boolean} [options.unshift=false] Add the song/playlist to the beginning of the queue (after the playing song if exists)
   * @param {Discord.GuildMember} [options.member] Requested user (default is your bot)
   * @param {Discord.TextChannel} [options.textChannel=null] Default {@link Queue#textChannel} (if the queue wasn't created)
   * @param {Discord.Message} [options.message] Called message (For built-in search events. If this is a {@link https://developer.mozilla.org/en-US/docs/Glossary/Falsy|falsy value}, it will play the first result instead)
   */
  async playVoiceChannel(voiceChannel, song, options = {}) {
    if (!["voice", "stage"].includes(voiceChannel?.type)) {
      throw new TypeError("voiceChannel is not a Discord.VoiceChannel or a Discord.StageChannel.");
    }
    if (typeof options !== "object" || Array.isArray(options)) {
      throw new TypeError("options must be an object.");
    }
    const { textChannel, member, skip, message, unshift } = Object.assign({
      member: voiceChannel.guild.me,
      skip: false,
      unshift: false,
    }, options);
    if (message && !(message instanceof Discord.Message)) {
      throw new TypeError("options.message is not a Discord.Message or a falsy value.");
    }
    try {
      if (typeof song === "string") {
        for (const plugin of this.customPlugins) {
          if (await plugin.validate(song)) {
            await plugin.play(voiceChannel, song, member, textChannel, skip, unshift);
            return;
          }
        }
      }
      if (song instanceof SearchResult && song.type === "playlist") song = song.url;
      if (ytpl.validateID(song)) song = await this.handler.resolvePlaylist(member, song);
      song = await this.handler.resolveSong(message || member, song);
      if (!song) return;
      if (song instanceof Playlist) await this.handler.handlePlaylist(voiceChannel, song, textChannel, skip, unshift);
      else if (!this.options.nsfw && song.age_restricted && !textChannel?.nsfw) {
        throw new Error("Cannot play age-restricted content in non-NSFW channel.");
      } else {
        let queue = this.getQueue(voiceChannel);
        if (queue) {
          queue.addToQueue(song, skip || unshift ? 1 : -1);
          if (skip) queue.skip();
          else this.emit("addSong", queue, song);
        } else {
          queue = await this._newQueue(voiceChannel, song, textChannel);
          if (queue instanceof Queue) this.emit("playSong", queue, song);
        }
      }
    } catch (e) {
      try {
        e.name = "PlayError";
        e.message = `${song?.url || song}\n${e.message}`;
      } catch { }
      this.emitError(textChannel, e);
    }
  }

  /**
   * Play or add array of video urls.
   * {@link DisTube#event:playSong} or {@link DisTube#event:addList} will be emitted
   * with `playlist`'s properties include `properties` parameter's properties such as
   * `user`, `songs`, `duration`, `formattedDuration`, `thumbnail` like {@link Playlist}
   * @returns {Promise<void>}
   * @param {Discord.Message} message A message from guild channel
   * @param {Array<string|Song|SearchResult>} songs Array of url, Song or SearchResult
   * @param {Object} [properties={}] Additional properties such as `name`
   * @param {Object} [options] Optional options
   * @param {boolean} [options.skip=false] Skip the playing song (if exists) and play the added song/playlist instantly
   * @param {boolean} [options.unshift=false] Add the song/playlist to the beginning of the queue (after the playing song if exists)
   * @param {boolean} [options.parallel=true] Whether or not fetch the songs in parallel
   * @example
   *     let songs = ["https://www.youtube.com/watch?v=xxx", "https://www.youtube.com/watch?v=yyy"];
   *     distube.playCustomPlaylist(message, songs, { name: "My playlist name" });
   *     // Fetching custom playlist sequentially (reduce lag for low specs)
   *     distube.playCustomPlaylist(message, songs, { name: "My playlist name" }, false, false);
   */
  async playCustomPlaylist(message, songs, properties = {}, options = {}) {
    try {
      if (typeof options !== "object" || Array.isArray(options)) {
        throw new TypeError("options must be an object.");
      }
      const { skip, unshift, parallel } = Object.assign({
        skip: false,
        unshift: false,
        parallel: true,
      }, options);
      const playlist = await this.handler.createCustomPlaylist(message, songs, properties, parallel);
      await this.handler.handlePlaylist(message, playlist, skip, unshift);
    } catch (e) {
      this.emitError(message.channel, e);
    }
  }

  /**
   * Search for a song.
   * You can customize how user answers instead of send a number.
   * Then use {@link DisTube#play|play(message, aResultFromSearch)} or {@link DisTube#playSkip|playSkip()} to play it.
   * @param {string} string The string search for
   * @param {Object} options Search options
   * @param {number} [options.limit=10] Limit the results
   * @param {'video'|'playlist'} [options.type='video'] Type of search (`video` or `playlist`).
   * @param {boolean} [options.safeSearch=false] Whether or not use safe search (YouTube restricted mode)
   * @throws {Error}
   * @returns {Promise<Array<SearchResult>>} Array of results
   */
  async search(string, options = {}) {
    const opts = Object.assign({ type: "video", limit: 10, safeSearch: false }, options);
    if (typeof opts.type !== "string" || !["video", "playlist"].includes(opts.type)) throw new Error("options.type must be 'video' or 'playlist'.");
    if (typeof opts.limit !== "number") throw new Error("options.limit must be a number");
    if (opts.limit < 1) throw new Error("option.limit must be bigger or equal to 1");
    if (typeof opts.safeSearch !== "boolean") throw new TypeError("options.safeSearch must be a boolean.");

    try {
      const search = await ytsr(string, opts);
      const results = search.items.map(i => new SearchResult(i));
      if (results.length === 0) throw Error("No result!");
      return results;
    } catch (e) {
      if (options.retried) throw e;
      options.retried = true;
      return this.search(string, options);
    }
  }

  /**
   * Create a new guild queue
   * @private
   * @param {Discord.Message|Discord.VoiceChannel|Discord.StageChannel} message A message from guild channel | a voice channel
   * @param {Song|Array<Song>} song Song to play
   * @param {Discord.TextChannel} textChannel A text channel of the queue
   * @throws {Error}
   * @returns {Promise<Queue|true>} `true` if queue is not generated
   */
  _newQueue(message, song, textChannel = message.channel) {
    const voice = message?.member?.voice?.channel || message;
    if (!voice || voice instanceof Discord.Message) throw new Error("User is not in a voice channel.");
    if (!["voice", "stage"].includes(voice?.type)) {
      throw new TypeError("User is not in a Discord.VoiceChannel or a Discord.StageChannel.");
    }
    const queue = new Queue(this, message, song, textChannel);
    this.emit("initQueue", queue);
    this.guildQueues.set(message.guild.id, queue);
    return this.handler.joinVoiceChannel(queue, voice);
  }

  /**
   * Delete a guild queue
   * @private
   * @param {QueueResolvable} queue The type can be resolved to give a {@link Queue}
   */
  _deleteQueue(queue) {
    const q = this.getQueue(queue);
    if (!q) return;
    this.emit("deleteQueue", q);
    this.guildQueues.delete(q.id);
    try { q.dispatcher?.destroy() } catch { }
    try { q.stream?.destroy() } catch { }
  }

  /**
   * Get the guild queue
   * @param {QueueResolvable} queue The type can be resolved to give a {@link Queue}
   * @returns {Queue}
   * @throws {Error}
   * @example
   * client.on('message', (message) => {
   *     if (!message.content.startsWith(config.prefix)) return;
   *     const args = message.content.slice(config.prefix.length).trim().split(/ +/g);
   *     const command = args.shift();
   *     if (command == "queue") {
   *         const queue = distube.getQueue(message);
   *         message.channel.send('Current queue:\n' + queue.songs.map((song, id) =>
   *             `**${id+1}**. [${song.name}](${song.url}) - \`${song.formattedDuration}\``
   *         ).join("\n"));
   *     }
   * });
   */
  getQueue(queue) {
    if (queue instanceof Queue) return queue;
    const guildID = queue?.guild?.id || queue;
    if (
      typeof guildID !== "string" ||
      !guildID.match(/^\d+$/) ||
      guildID.length <= 15
    ) throw TypeError("The parameter must be a QueueResolvable!");
    return this.guildQueues.get(guildID);
  }

  /**
   * Pause the guild stream
   * @param {QueueResolvable} queue The type can be resolved to give a {@link Queue}
   * @returns {Queue} The guild queue
   * @throws {Error}
   */
  pause(queue) {
    const q = this.getQueue(queue);
    if (!q) throw new Error("Cannot find the playing queue.");
    return q.pause();
  }

  /**
   * Resume the guild stream
   * @param {QueueResolvable} queue The type can be resolved to give a {@link Queue}
   * @returns {Queue} The guild queue
   * @throws {Error}
   */
  resume(queue) {
    const q = this.getQueue(queue);
    if (!q) throw new Error("Cannot find the playing queue.");
    return q.resume();
  }

  /**
   * Stop the guild stream
   * @param {QueueResolvable} queue The type can be resolved to give a {@link Queue}
   * @throws {Error}
   * @example
   * client.on('message', (message) => {
   *     if (!message.content.startsWith(config.prefix)) return;
   *     const args = message.content.slice(config.prefix.length).trim().split(/ +/g);
   *     const command = args.shift();
   *     if (command == "stop") {
   *         distube.stop(message);
   *         message.channel.send("Stopped the queue!");
   *     }
   * });
   */
  stop(queue) {
    const q = this.getQueue(queue);
    if (!q) throw new Error("Cannot find the playing queue.");
    q.stop();
  }

  /**
   * Set the guild stream's volume
   * @param {QueueResolvable} queue The type can be resolved to give a {@link Queue}
   * @param {number} percent The percentage of volume you want to set
   * @returns {Queue} The guild queue
   * @throws {Error}
   * @example
   * client.on('message', (message) => {
   *     if (!message.content.startsWith(config.prefix)) return;
   *     const args = message.content.slice(config.prefix.length).trim().split(/ +/g);
   *     const command = args.shift();
   *     if (command == "volume")
   *         distube.setVolume(message, Number(args[0]));
   * });
   */
  setVolume(queue, percent) {
    const q = this.getQueue(queue);
    if (!q) throw new Error("Cannot find the playing queue.");
    return q.setVolume(percent);
  }

  /**
   * Skip the playing song
   * @param {QueueResolvable} queue The type can be resolved to give a {@link Queue}
   * @returns {Queue} The guild queue
   * @throws {Error}
   * @example
   * client.on('message', (message) => {
   *     if (!message.content.startsWith(config.prefix)) return;
   *     const args = message.content.slice(config.prefix.length).trim().split(/ +/g);
   *     const command = args.shift();
   *     if (command == "skip")
   *         distube.skip(message);
   * });
   */
  skip(queue) {
    const q = this.getQueue(queue);
    if (!q) throw new Error("Cannot find the playing queue.");
    return q.skip();
  }

  /**
   * Play the previous song
   * @param {QueueResolvable} queue The type can be resolved to give a {@link Queue}
   * @returns {Queue} The guild queue
   * @throws {Error}
   * @example
   * client.on('message', (message) => {
   *     if (!message.content.startsWith(config.prefix)) return;
   *     const args = message.content.slice(config.prefix.length).trim().split(/ +/g);
   *     const command = args.shift();
   *     if (command == "previous")
   *         distube.previous(message);
   * });
   */
  previous(queue) {
    if (!this.options.savePreviousSongs) throw new Error("Disabled");
    const q = this.getQueue(queue);
    if (!q) throw new Error("Cannot find the playing queue.");
    return q.previous();
  }

  /**
   * Shuffle the guild queue songs
   * @param {QueueResolvable} queue The type can be resolved to give a {@link Queue}
   * @returns {Queue} The guild queue
   * @example
   * client.on('message', (message) => {
   *     if (!message.content.startsWith(config.prefix)) return;
   *     const args = message.content.slice(config.prefix.length).trim().split(/ +/g);
   *     const command = args.shift();
   *     if (command == "shuffle")
   *         distube.shuffle(message);
   * });
   */
  shuffle(queue) {
    const q = this.getQueue(queue);
    if (!q) throw new Error("Cannot find the playing queue.");
    return q.shuffle();
  }

  /**
   * Jump to the song number in the queue.
   * The next one is 1, 2,...
   * The previous one is -1, -2,...
   * @param {QueueResolvable} queue The type can be resolved to give a {@link Queue}
   * @param {number} num The song number to play
   * @returns {Queue} The guild queue
   * @throws {Error} if `num` is invalid number (0 < num < {@link Queue#songs}.length)
   * @example
   * client.on('message', (message) => {
   *     if (!message.content.startsWith(config.prefix)) return;
   *     const args = message.content.slice(config.prefix.length).trim().split(/ +/g);
   *     const command = args.shift();
   *     if (command == "jump")
   *         distube.jump(message, parseInt(args[0]))
   *             .catch(err => message.channel.send("Invalid song number."));
   * });
   */
  jump(queue, num) {
    const q = this.getQueue(queue);
    if (!q) throw new Error("Cannot find the playing queue.");
    return q.jump(num);
  }

  /**
   * Set the repeat mode of the guild queue.
   * Turn off if repeat mode is the same value as new mode.
   * Toggle mode: `mode = null` `(0 -> 1 -> 2 -> 0...)`
   * @param {QueueResolvable} queue The type can be resolved to give a {@link Queue}
   * @param {number} mode The repeat modes `(0: disabled, 1: Repeat a song, 2: Repeat all the queue)`
   * @returns {number} The new repeat mode
   * @example
   * client.on('message', (message) => {
   *     if (!message.content.startsWith(config.prefix)) return;
   *     const args = message.content.slice(config.prefix.length).trim().split(/ +/g);
   *     const command = args.shift();
   *     if (command == "repeat") {
   *         let mode = distube.setRepeatMode(message, parseInt(args[0]));
   *         mode = mode ? mode == 2 ? "Repeat queue" : "Repeat song" : "Off";
   *         message.channel.send("Set repeat mode to `" + mode + "`");
   *     }
   * });
   */
  setRepeatMode(queue, mode = null) {
    const q = this.getQueue(queue);
    if (!q) throw new Error("Cannot find the playing queue.");
    return q.setRepeatMode(mode);
  }

  /**
   * Toggle autoplay mode
   * @param {QueueResolvable} queue The type can be resolved to give a {@link Queue}
   * @returns {boolean} Autoplay mode state
   * @throws {Error}
   * @example
   * client.on('message', (message) => {
   *     if (!message.content.startsWith(config.prefix)) return;
   *     const args = message.content.slice(config.prefix.length).trim().split(/ +/g);
   *     const command = args.shift();
   *     if (command == "autoplay") {
   *         let mode = distube.toggleAutoplay(message);
   *         message.channel.send("Set autoplay mode to `" + (mode ? "On" : "Off") + "`");
   *     }
   * });
   */
  toggleAutoplay(queue) {
    const q = this.getQueue(queue);
    if (!q) throw new Error("Cannot find the playing queue.");
    return q.toggleAutoplay();
  }

  /**
   * Add related song to the queue
   * @param {QueueResolvable} queue The type can be resolved to give a {@link Queue}
   * @returns {Promise<Queue>} The guild queue
   */
  addRelatedSong(queue) {
    const q = this.getQueue(queue);
    if (!q) throw new Error("Cannot find the playing queue.");
    return q.addRelatedSong();
  }

  /**
   * Enable or disable a filter of the queue.
   * Available filters: {@link Filters}
   * @param {QueueResolvable} queue The type can be resolved to give a {@link Queue}
   * @param {string|false} filter A filter name, `false` to clear all the filters
   * @returns {Array<string>} Enabled filters.
   * @example
   * client.on('message', (message) => {
   *     if (!message.content.startsWith(config.prefix)) return;
   *     const args = message.content.slice(config.prefix.length).trim().split(/ +/g);
   *     const command = args.shift();
   *     if ([`3d`, `bassboost`, `echo`, `karaoke`, `nightcore`, `vaporwave`].includes(command)) {
   *         let filter = distube.setFilter(message, command);
   *         message.channel.send("Current queue filter: " + (filter.join(", ") || "Off"));
   *     }
   * });
   */
  setFilter(queue, filter) {
    const q = this.getQueue(queue);
    if (!q) throw new Error("Cannot find the playing queue.");
    return q.setFilter(filter);
  }

  /**
   * Set the playing time to another position
   * @param {QueueResolvable} queue The type can be resolved to give a {@link Queue}
   * @param {number} time Time in seconds
   * @returns {Queue} Seeked queue
   * @example
   * client.on('message', message => {
   *     if (!message.content.startsWith(config.prefix)) return;
   *     const args = message.content.slice(config.prefix.length).trim().split(/ +/g);
   *     const command = args.shift();
   *     if (command = 'seek')
   *         distube.seek(message, Number(args[0]));
   * });
   */
  seek(queue, time) {
    const q = this.getQueue(queue);
    if (!q) throw new Error("Cannot find the playing queue.");
    return q.seek(time);
  }

  /**
   * Emit error event
   * @param {Discord.TextChannel} channel Text channel where the error is encountered.
   * @param {Error} error error
   * @private
   */
  emitError(channel, error) {
    if (!channel || !(channel instanceof Discord.TextChannel)) {
      console.error(error);
      console.warn("This is logged because <Queue>.textChannel is null");
    } else if (this.listeners("error").length) this.emit("error", channel, error);
    else this.emit("error", error);
  }
}

DisTube.CustomPlugin = CustomPlugin;
DisTube.ExtractorPlugin = ExtractorPlugin;
DisTube.Playlist = Playlist;
DisTube.Song = Song;
DisTube.Queue = Queue;
DisTube.SearchResult = SearchResult;
DisTube.Util = require("./struct/Util");
module.exports = DisTube;

/**
 * Emitted after DisTube add a new playlist to the playing {@link Queue}
 *
 * @event DisTube#addList
 * @param {Queue} queue The guild queue
 * @param {Playlist} playlist Playlist info
 * @example
 * distube.on("addList", (queue, playlist) => queue.textChannel.send(
 *     `Added \`${playlist.name}\` playlist (${playlist.songs.length} songs) to the queue!`
 * ));
 */

/**
 *  Emitted after DisTube add a new song to the playing {@link Queue}
 *
 * @event DisTube#addSong
 * @param {Queue} queue The guild queue
 * @param {Song} song Added song
 * @example
 * distube.on("addSong", (queue, song) => queue.textChannel.send(
 *     `Added ${song.name} - \`${song.formattedDuration}\` to the queue by ${song.user}.`
 * ));
 */

/**
 * Emitted when there is no user in the voice channel, {@link DisTubeOptions}.leaveOnEmpty is `true` and there is a playing queue.
 * If there is no playing queue (stopped and {@link DisTubeOptions}.leaveOnStop is `false`), it will leave the channel without emitting this event.
 *
 * @event DisTube#empty
 * @param {Queue} queue The guild queue
 * @example
 * distube.on("empty", queue => queue.textChannel.send("Channel is empty. Leaving the channel"))
 */

/**
 * Emitted when {@link DisTube} encounters an error.
 *
 * @event DisTube#error
 * @param {Discord.TextChannel} channel Text channel where the error is encountered.
 * @param {Error} error The error encountered
 * @example
 * distube.on("error", (channel, error) => channel.send(
 *     "An error encountered: " + error
 * ));
 */

/**
 * Emitted when there is no more song in the queue and {@link Queue#autoplay} is `false`.
 * DisTube will leave voice channel if {@link DisTubeOptions}.leaveOnFinish is `true`
 *
 * @event DisTube#finish
 * @param {Queue} queue The guild queue
 * @example
 * distube.on("finish", queue => queue.textChannel.send("No more song in queue"));
 */

/**
 * Emitted when DisTube initialize a queue to change queue default properties.
 *
 * @event DisTube#initQueue
 * @param {Queue} queue The guild queue
 * @example
 * distube.on("initQueue", queue => {
 *     queue.autoplay = false;
 *     queue.volume = 100;
 * });
 */

/**
 * Emitted when {@link Queue#autoplay} is `true`, the {@link Queue#songs} is empty and
 * DisTube cannot find related songs to play
 *
 * @event DisTube#noRelated
 * @param {Queue} queue The guild queue
 * @example
 * distube.on("noRelated", queue => queue.textChannel.send("Can't find related video to play."));
 */

/**
 * Emitted when DisTube play a song.
 * If {@link DisTubeOptions}.emitNewSongOnly is `true`, event is not emitted when looping a song or next song is the previous one
 *
 * @event DisTube#playSong
 * @param {Queue} queue The guild queue
 * @param {Song} song Playing song
 * @example
 * const status = (queue) => `Volume: \`${queue.volume}%\` | Loop: \`${queue.repeatMode ? queue.repeatMode == 2 ? "Server Queue" : "This Song" : "Off"}\` | Autoplay: \`${queue.autoplay ? "On" : "Off"}\``;
 * distube.on("playSong", (queue, song) => queue.textChannel.send(
 *     `Playing \`${song.name}\` - \`${song.formattedDuration}\`\nRequested by: ${song.user}\n${status(queue)}`
 * ));
 */

/**
 * Emitted when DisTube cannot find any results for the query
 *
 * @event DisTube#searchNoResult
 * @param {Discord.Message} message The user message called play method
 * @param {string} query The search query
 * @example
 * distube.on("searchNoResult", (message, query) => message.channel.send(`No result found for ${query}!`));
 */

/**
 * Emitted when {@link DisTubeOptions|DisTubeOptions.searchSongs} bigger than 0
 * and the search canceled due to user's next message is invalid number or timeout
 *
 * @event DisTube#searchCancel
 * @param {Discord.Message} message The user message called play method
 * @param {string} query The search query
 * @example
 * // DisTubeOptions.searchSongs > 0
 * distube.on("searchCancel", (message) => message.channel.send(`Searching canceled`));
 */

/**
 * Emitted when {@link DisTubeOptions|DisTubeOptions.searchSongs} bigger than 0
 * and song param of {@link DisTube#play|play()} is invalid url.
 * DisTube will wait for user's next message to choose song manually.
 * <info>{@link https://support.google.com/youtube/answer/7354993|Safe search} is enabled
 * if {@link DisTubeOptions}.nsfw is disabled and the message's channel is not a nsfw channel.</info>
 *
 * @event DisTube#searchResult
 * @param {Discord.Message} message The user message called play method
 * @param {Array<SearchResult>} results Searched results
 * @param {string} query The search query
 * @example
 * // DisTubeOptions.searchSongs > 0
 * distube.on("searchResult", (message, results) => {
 *     message.channel.send(`**Choose an option from below**\n${results.map((song, i) => `**${i + 1}**. ${song.name} - \`${song.formattedDuration}\``).join("\n")}\n*Enter anything else or wait 60 seconds to cancel*`);
 * });
 */

/**
 * Emitted when {@link DisTubeOptions|DisTubeOptions.searchSongs} bigger than 0
 * and after the user chose a search result to play
 *
 * @event DisTube#searchDone
 * @param {Discord.Message} message The user message called play method
 * @param {Discord.Message} answer The answered message of user
 * @param {string} query The search query
 */

/**
 * Emitted when the bot is connected to the voice channel
 *
 * @event DisTube#connect
 * @param {Queue} queue The guild queue
 */

/**
 * Emitted when the bot is disconnected to the voice channel
 *
 * @event DisTube#disconnect
 * @param {Queue} queue The guild queue
 */

/**
 * Emitted when a {@link Queue} is deleted with any reasons.
 *
 * @event DisTube#deleteQueue
 * @param {Queue} queue The guild queue
 */

/**
 * Emitted when DisTube finished a song
 *
 * @event DisTube#finishSong
 * @param {Queue} queue The guild queue
 * @param {Song} song Finished song
 */
