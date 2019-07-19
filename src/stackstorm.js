// Copyright 2019 Extreme Networks, Inc.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
//
// Description:
//   StackStorm hubot integration
//
// Dependencies:
//
//
// Configuration:
//   ST2_API_URL - FQDN + port to StackStorm endpoint
//   ST2_ROUTE - StackStorm notification route name
//   ST2_COMMANDS_RELOAD_INTERVAL - Reload interval for commands
//
// Notes:
//   Command list is automatically generated from StackStorm ChatOps metadata
//

"use strict";

var _ = require('lodash'),
  util = require('util'),
  env = _.clone(process.env),
  Promise = require('rsvp').Promise,
  utils = require('./lib/utils.js'),
  formatCommand = require('./lib/format_command.js'),
  CommandFactory = require('./lib/command_factory.js'),
  adapters = require('./lib/adapters'),
  st2client = require('st2client'),
  uuid = require('uuid')
  ;

// Setup the Environment
env.ST2_API_URL = env.ST2_API || env.ST2_API_URL || 'http://localhost:9101';
env.ST2_ROUTE = env.ST2_ROUTE || null;
env.ST2_WEBUI_URL = env.ST2_WEBUI_URL || null;

// Optional authentication info
env.ST2_AUTH_USERNAME = env.ST2_AUTH_USERNAME || null;
env.ST2_AUTH_PASSWORD = env.ST2_AUTH_PASSWORD || null;

// Optional authentication token
env.ST2_AUTH_TOKEN = env.ST2_AUTH_TOKEN || null;

// Optional API key
env.ST2_API_KEY = env.ST2_API_KEY || null;

// slack attachment colors
env.ST2_SLACK_SUCCESS_COLOR = env.ST2_SLACK_SUCCESS_COLOR || 'dfdfdf';
env.ST2_SLACK_FAIL_COLOR = env.ST2_SLACK_FAIL_COLOR || 'danger';

// Optional, if not provided, we infer it from the API URL
env.ST2_AUTH_URL = env.ST2_AUTH_URL || null;

// Optional, if not provided, we infer it from the API URL
env.ST2_STREAM_URL = env.ST2_STREAM_URL || null;

// Command reload interval in seconds
env.ST2_COMMANDS_RELOAD_INTERVAL = parseInt(env.ST2_COMMANDS_RELOAD_INTERVAL || 120, 10);

// Cap message length to a certain number of characters.
env.ST2_MAX_MESSAGE_LENGTH = parseInt(env.ST2_MAX_MESSAGE_LENGTH || 500, 10);

// Constants
// Fun human-friendly commands. Use %s for payload output.
var START_MESSAGES = [
  "I'll take it from here! Your execution ID for reference is %s",
  "Got it! Remember %s as your execution ID",
  "I'm on it! Your execution ID is %s",
  "Let me get right on that. Remember %s as your execution ID",
  "Always something with you. :) I'll take care of that. Your ID is %s",
  "I have it covered. Your execution ID is %s",
  "Let me start up the machine! Your execution ID is %s",
  "I'll throw that task in the oven and get cookin'! Your execution ID is %s",
  "Want me to take that off your hand? You got it! Don't forget your execution ID: %s",
  "River Tam will get it done with her psychic powers. Your execution ID is %s"
];

var ERROR_MESSAGES = [
  "I'm sorry, Dave. I'm afraid I can't do that. {~} %s"
];

var TWOFACTOR_MESSAGE = "This action requires two-factor auth! Waiting for your confirmation.";


module.exports = function(robot) {
  // Makes the script crash on unhandled rejections instead of ignoring them and keep running.
  // Usually happens when trying to connect to a nonexistent instances or similar unrecoverable issues.
  // In the future Node.js versions, promise rejections that are not handled will terminate the process with a non-zero exit code.
  process.on('unhandledRejection', function(err) {
    throw err;
  });

  // Handle uncaught exceptions, log error and terminate hubot if one occurs
  robot.error(function(err, res) {
    if (err) {
      robot.logger.error(err.stack || JSON.stringify(err));
    }
    if (res) {
      res.send(JSON.stringify({
        "status": "failed",
        "msg": "An error occurred trying to post the message:\n" + err
      }));
    }

    robot.logger.info('Hubot will shut down ...');
    robot.shutdown();
  });

  var self = this;

  var promise = Promise.resolve();

  if (env.ST2_API) {
    robot.logger.warning("ST2_API is deprecated and will be removed in a future releases. Instead, please use the ST2_API_URL environment variable.");
  }
  var self = this,
    authenticated = Promise.resolve(),
    url = utils.parseUrl(env.ST2_API_URL),
    opts = {
      protocol: url.protocol,
      host: url.hostname,
      port: url.port,
      prefix: url.path,
      rejectUnauthorized: false
    };

  if (env.ST2_STREAM_URL) {
    var stream_url = utils.parseUrl(env.ST2_STREAM_URL);
    opts.stream = {
      protocol: stream_url.protocol,
      host: stream_url.hostname,
      port: stream_url.port,
      prefix: stream_url.path
    };
  }

  var api_client = st2client(opts);

  function authenticate() {
    api_client.removeListener('expiry', authenticate);

    // API key gets precedence 1
    if (env.ST2_API_KEY) {
      robot.logger.info('Using ST2_API_KEY as authentication. Expiry will lead to bot exit.');
      return Promise.resolve();
    }
    // Auth token gets precedence 2
    if (env.ST2_AUTH_TOKEN) {
      robot.logger.info('Using ST2_AUTH_TOKEN as authentication. Expiry will lead to bot exit.');
      return Promise.resolve();
    }

    robot.logger.info('Requesting a token...');

    var url = utils.parseUrl(env.ST2_AUTH_URL);

    var auth_client = st2client({
      auth: {
        protocol: url.protocol,
        host: url.hostname,
        port: url.port,
        prefix: url.path
      }
    });

    return auth_client.authenticate(env.ST2_AUTH_USERNAME, env.ST2_AUTH_PASSWORD)
      .then(function (token) {
        robot.logger.info('Token received. Expiring ' + token.expiry);
        api_client.setToken(token);
        auth_client.on('expiry', authenticate);
      })
      .catch(function (err) {
        robot.logger.error('Failed to authenticate: ' + err.message);

        throw err;
      });
  }

  // factory to manage commands
  var command_factory = new CommandFactory(robot);

  // adapter - specific to each chat provider
  var adapter = adapters.getAdapter(robot.adapterName, robot);

  var loadCommands = function() {
    robot.logger.info('Loading commands....');

    api_client.actionAlias.list({limit: -1})
      .then(function (aliases) {
        // Remove all the existing commands
        command_factory.removeCommands();

        _.each(aliases, function (alias) {
          var name = alias.name;
          var formats = alias.formats;
          var description = alias.description;

          if (alias.enabled === false) {
            return;
          }

          if (!formats || formats.length === 0) {
            robot.logger.error('No formats specified for command: ' + name);
            return;
          }

          _.each(formats, function (format) {
            var command = formatCommand(robot.logger, name, format.display || format, description);
            command_factory.addCommand(command, name, format.display || format, alias,
                                       format.display ? utils.DISPLAY : false);

            _.each(format.representation, function (representation) {
              command = formatCommand(robot.logger, name, representation, description);
              command_factory.addCommand(command, name, representation, alias, utils.REPRESENTATION);
            });
          });
        });

        robot.logger.info(command_factory.st2_hubot_commands.length + ' commands are loaded');
      })
      .catch(function (err) {
        robot.logger.error(util.format('Failed to retrieve commands from "%s": %s', env.ST2_API_URL, err.message));
        if (err.status === 401 || err.message.includes('Unauthorized')) {
          throw err;
        }
      });
  };

  var sendAck = function (msg, res) {
    var history_url = utils.getExecutionHistoryUrl(res.execution);
    var history = history_url ? util.format(' (details available at %s)', history_url) : '';

    if (res.actionalias && res.actionalias.ack) {
      if (res.actionalias.ack.enabled === false) {
        return;
      } else if (res.actionalias.ack.append_url === false) {
        history = '';
      }
    }

    if (res.message) {
      return msg.send(res.message + history);
    }

    var message = util.format(_.sample(START_MESSAGES), res.execution.id);
    return msg.send(message + history);
  };

  var sendAliasExecutionRequest = function (msg, payload) {
    robot.logger.debug('Sending command payload:', JSON.stringify(payload));

    api_client.aliasExecution.create(payload)
      .then(function (res) { sendAck(msg, res); })
      .catch(function (err) {
        // Compatibility with older StackStorm versions
        if (err.status === 200) {
          return sendAck(msg, { execution: { id: err.message } });
        }
        robot.logger.error('Failed to create an alias execution:', err);
        var addressee = adapter.normalizeAddressee(msg);
        var message = util.format(_.sample(ERROR_MESSAGES), err.message);
        if (err.requestId) {
          message = util.format(
            message,
            util.format('; Use request ID %s to grep st2 api logs.', err.requestId));
        }
        adapter.postData({
          whisper: false,
          user: addressee.name,
          channel: addressee.room,
          message: message,
          extra: {
            color: '#F35A00'
          }
        });
      });
  };

  var executeCommand = function(msg, command_name, format_string, command, action_alias) {
    var addressee = adapter.normalizeAddressee(msg);
    var payload = {
      'name': command_name,
      'format': format_string,
      'command': command,
      'user': addressee.name,
      'source_channel': addressee.room,
      'source_context': msg.envelope,
      'notification_route': env.ST2_ROUTE || 'hubot'
    };

    if (utils.enable2FA(action_alias)) {
      var twofactor_id = uuid.v4();
      robot.logger.debug('Requested an action that requires 2FA. Guid: ' + twofactor_id);
      msg.send(TWOFACTOR_MESSAGE);
      api_client.executions.create({
        'action': env.HUBOT_2FA,
        'parameters': {
          'uuid': twofactor_id,
          'user': addressee.name,
          'channel': addressee.room,
          'hint': action_alias.description
        }
      });
      twofactor[twofactor_id] = {
        'msg': msg,
        'payload': payload
      };
    } else {
      sendAliasExecutionRequest(msg, payload);
    }
  };

  robot.respond(/([\s\S]+?)$/i, function(msg) {
    var command, result;

    // Normalize the command and remove special handling provided by the chat service.
    // e.g. slack replace quote marks with left double quote which would break behavior.
    command = adapter.normalizeCommand(msg.match[1]);

    result = command_factory.getMatchingCommand(command);

    if (!result) {
      // No command found
      return;
    }

    var [command_name, format_string, action_alias] = result;

    executeCommand(msg, command_name, format_string, command, action_alias);
  });

  robot.router.post('/hubot/st2', function(req, res) {
    var data;

    try {
      if (req.body.payload) {
        data = JSON.parse(req.body.payload);
      } else {
        data = req.body;
      }
      adapter.postData(data);

      res.send('{"status": "completed", "msg": "Message posted successfully"}');
    } catch (e) {
      robot.logger.error("Unable to decode JSON: " + e);
      robot.logger.error(e.stack);
      res.send('{"status": "failed", "msg": "An error occurred trying to post the message: ' + e + '"}');
    }
  });

  var commands_load_interval;

  function start() {
    api_client.stream.listen().catch(function (err) {
      robot.logger.error('Unable to connect to stream:', err);
    }).then(function (st2stream) {
      st2stream.onerror = function (err) {
        // TODO: squeeze a little bit more info out of evensource.js
        robot.logger.warning('Stream error:', err);
        if (err.status === 401) {
          throw err;
        }
      };
      st2stream.addEventListener('st2.announcement__chatops', function (e) {
        var data;

        robot.logger.debug('Chatops message received:', e.data);

        if (e.data) {
          data = JSON.parse(e.data).payload;
        } else {
          data = e.data;
        }

        adapter.postData(data);
      });

      if (env.HUBOT_2FA) {
        st2stream.addEventListener('st2.announcement__2fa', function (e) {
          var data;

          robot.logger.debug('Successfull two-factor auth:', e.data);

          if (e.data) {
            data = JSON.parse(e.data).payload;
          } else {
            data = e.data;
          }

          var executionData = twofactor[data.uuid];
          sendAliasExecutionRequest(executionData.msg, executionData.payload);
          delete twofactor[data.uuid];
        });
      }
    });

    // Add an interval which tries to re-load the commands
    commands_load_interval = setInterval(loadCommands.bind(self), (env.ST2_COMMANDS_RELOAD_INTERVAL * 1000));

    // Initial command loading
    loadCommands();

    // Install SIGUSR2 handler which reloads the command
    install_sigusr2_handler();
  }

  function stop() {
    clearInterval(commands_load_interval);
    api_client.stream.listen().then(function (st2stream) {
      st2stream.removeAllListeners();
      st2stream.close();
    });
  }

  function install_sigusr2_handler() {
    process.on('SIGUSR2', function() {
      robot.logger.debug("Caught SIGUSR2, reloading commands");
      loadCommands();
    });
  }

  if (env.ST2_API_KEY) {
    api_client.setKey({ key: env.ST2_API_KEY });
  } else if (env.ST2_AUTH_TOKEN) {
    api_client.setToken({ token: env.ST2_AUTH_TOKEN });
  }

  if (env.ST2_API_KEY || env.ST2_AUTH_TOKEN || env.ST2_AUTH_USERNAME || env.ST2_AUTH_PASSWORD) {
    // If using username and password then all are required.
    if ((env.ST2_AUTH_USERNAME || env.ST2_AUTH_PASSWORD) &&
        !(env.ST2_AUTH_USERNAME && env.ST2_AUTH_PASSWORD && env.ST2_AUTH_URL)) {
      throw new Error('Env variables ST2_AUTH_USERNAME, ST2_AUTH_PASSWORD and ST2_AUTH_URL should only be used together.');
    }
    authenticated = authenticate();
  }

  // Pending 2-factor auth commands
  if (env.HUBOT_2FA) {
    var twofactor = {};
    robot.logger.info('Two-factor auth is enabled');
  }

  // Authenticate with StackStorm backend and then call start.
  // On a failure to authenticate log the error but do not quit.
  return authenticated.then(function () {
    start();
    return stop;
  });
};