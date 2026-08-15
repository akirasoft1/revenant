// gRPC client for the Python agent sidecar.
//
// Polls the sidecar's Health endpoint on a fixed interval; isHealthy() answers
// whether the last successful health response was within unhealthyThresholdMs.
// chat() rejects immediately when unhealthy so callers can fall through to
// the existing direct-OpenAI path without paying the gRPC dial timeout.

const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');
const logger = require('../logger');

class AgentClient {
  constructor({
    address,
    protoPath,
    healthIntervalMs = 5000,
    unhealthyThresholdMs = 30000,
    // LOCKSTEP with the sidecar's AGENT_CHAT_TIMEOUT_SECONDS (540s in
    // k8s/sandbox/configmap-sandbox.yaml). That value MUST stay below this one
    // so the sidecar abandons a stuck turn and returns a real error before this
    // deadline fires. If the bot times out first, the sidecar keeps working on a
    // turn nobody is waiting for AND its health breaker never learns the turn
    // failed — which is the invisible-degradation failure this pair was added to
    // close. Change both in the same commit.
    chatDeadlineMs = 600000,
    healthDeadlineMs = 2000,
  }) {
    this.address = address;
    this.unhealthyThresholdMs = unhealthyThresholdMs;
    this.chatDeadlineMs = chatDeadlineMs;
    this.healthDeadlineMs = healthDeadlineMs;
    this._lastHealthyAt = 0;
    this._closed = false;

    const packageDef = protoLoader.loadSync(protoPath, {
      keepCase: true,
      longs: String,
      enums: String,
      defaults: true,
      oneofs: true,
    });
    const proto = grpc.loadPackageDefinition(packageDef).discordbot.agent;
    this._stub = new proto.Agent(address, grpc.credentials.createInsecure());

    this._healthTimer = setInterval(() => this._healthCheck(), healthIntervalMs);
    if (this._healthTimer.unref) this._healthTimer.unref();
    // Track previous health state so we can log transitions (not every tick).
    this._wasHealthy = null; // null = never reported, true/false = last seen
    this._healthCheck();
  }

  _healthCheck() {
    if (this._closed) return;
    const deadline = new Date(Date.now() + this.healthDeadlineMs);
    this._stub.Health({}, { deadline }, (err, resp) => {
      if (this._closed) return;
      const ok = !err && resp && resp.healthy;
      if (ok) {
        this._lastHealthyAt = Date.now();
      }
      // Log state transitions only — never every tick. Silent steady-state
      // is the goal; transitions are the signal an operator needs.
      if (this._wasHealthy === null || this._wasHealthy !== ok) {
        if (ok) {
          logger.info(`AgentClient health OK -> ${this.address}`);
        } else {
          const reason = err ? `${err.code || ''} ${err.message || err}`.trim() : 'no response';
          logger.warn(`AgentClient health FAILING -> ${this.address}: ${reason}`);
        }
        this._wasHealthy = ok;
      }
    });
  }

  isHealthy() {
    return Date.now() - this._lastHealthyAt < this.unhealthyThresholdMs;
  }

  chat(req) {
    return new Promise((resolve, reject) => {
      if (!this.isHealthy()) {
        reject(new Error('sidecar unhealthy'));
        return;
      }
      const deadline = new Date(Date.now() + this.chatDeadlineMs);
      this._stub.Chat(
        {
          user_id: req.userId,
          user_tag: req.userTag,
          channel_id: req.channelId,
          guild_id: req.guildId,
          interaction_id: req.interactionId,
          user_message: req.userMessage,
          image_url: req.imageUrl || '',
          system_prompt: req.systemPrompt || '',
          memory_context: req.memoryContext || '',
          history: Array.isArray(req.history) ? req.history.map((t) => ({ role: t.role, content: t.content })) : [],
        },
        { deadline },
        (err, resp) => {
          if (err) {
            logger.warn(`AgentClient.chat failed: ${err.message}`);
            return reject(err);
          }
          resolve({
            messageText: resp.message_text,
            summary: {
              executionCount: resp.summary ? resp.summary.execution_count || 0 : 0,
              anyFailed: resp.summary ? resp.summary.any_failed || false : false,
              executionIds: resp.summary ? resp.summary.execution_ids || [] : [],
            },
            fallbackOccurred: !!resp.fallback_occurred,
          });
        },
      );
    });
  }

  adminObserve(req) {
    return new Promise((resolve, reject) => {
      if (!this.isHealthy()) {
        reject(new Error('sidecar unhealthy'));
        return;
      }
      const deadline = new Date(Date.now() + this.chatDeadlineMs);
      this._stub.Observe(
        { user_id: req.userId, user_tag: req.userTag || '', question: req.question },
        { deadline },
        (err, resp) => {
          if (err) {
            logger.warn(`AgentClient.adminObserve failed: ${err.message}`);
            return reject(err);
          }
          resolve({
            answerText: resp.answer_text || '',
            dqlUsed: resp.dql_used || '',
            error: resp.error || '',
          });
        },
      );
    });
  }

  runDql(req) {
    return new Promise((resolve, reject) => {
      if (!this.isHealthy()) {
        reject(new Error('sidecar unhealthy'));
        return;
      }
      const deadline = new Date(Date.now() + this.chatDeadlineMs);
      this._stub.RunDql(
        { user_id: req.userId, query: req.query },
        { deadline },
        (err, resp) => {
          if (err) {
            logger.warn(`AgentClient.runDql failed: ${err.message}`);
            return reject(err);
          }
          resolve({
            rowsJson: resp.rows_json || '',
            columns: resp.columns || '',
            error: resp.error || '',
          });
        },
      );
    });
  }

  close() {
    this._closed = true;
    if (this._healthTimer) clearInterval(this._healthTimer);
    if (this._stub && typeof this._stub.close === 'function') {
      try {
        this._stub.close();
      } catch (e) {
        logger.debug(`AgentClient stub.close threw: ${e.message}`);
      }
    }
  }
}

module.exports = AgentClient;
