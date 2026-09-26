#!/usr/bin/env node
// scripts/ab-compare.js
// Run A/B comparisons between channel-voice and friendly personalities
//
// Usage:
//   kubectl port-forward svc/qdrant 6333:6333 -n discord-article-bot &
//   OPENAI_API_KEY=sk-... node scripts/ab-compare.js
//
//   # With custom sample count:
//   OPENAI_API_KEY=sk-... node scripts/ab-compare.js --count=5
//
//   # With custom message (instead of sampling from history):
//   OPENAI_API_KEY=sk-... node scripts/ab-compare.js --message="what do you guys think about the new iphone"

const OpenAI = require('openai');
const { QdrantClient } = require('@qdrant/js-client-rest');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
const QDRANT_HOST = process.env.QDRANT_HOST || 'localhost';
const QDRANT_PORT = parseInt(process.env.QDRANT_PORT || '6333', 10);
const MODEL = process.env.OPENAI_MODEL || 'gpt-6-luna';

// Parse args
const args = process.argv.slice(2);
const countArg = args.find(a => a.startsWith('--count='));
const messageArg = args.find(a => a.startsWith('--message='));
const SAMPLE_COUNT = countArg ? parseInt(countArg.split('=')[1], 10) : 10;
const CUSTOM_MESSAGE = messageArg ? messageArg.split('=').slice(1).join('=') : null;

if (!OPENAI_API_KEY) {
  console.error('Error: OPENAI_API_KEY environment variable required');
  process.exit(1);
}

// Load the voice profile and personality prompts
const channelVoicePersonality = require('../personalities/channel-voice');
const friendlyPersonality = require('../personalities/friendly-assistant');

const openai = new OpenAI({ apiKey: OPENAI_API_KEY, baseURL: OPENAI_BASE_URL });
const qdrant = new QdrantClient({ host: QDRANT_HOST, port: QDRANT_PORT });

/**
 * Load voice profile from MongoDB (via Qdrant pod proxy won't work, so we load from a file or env)
 * For simplicity, we'll fetch it by running the same analysis the bot does
 */
async function loadVoiceProfile() {
  // Try to connect to MongoDB directly
  const { MongoClient } = require('mongodb');
  const MONGO_URI = process.env.MONGO_URI || 'mongodb://admin:p4ssw0rdn3w@localhost:27017/discord?authSource=admin';

  let mongoClient;
  try {
    mongoClient = new MongoClient(MONGO_URI);
    await mongoClient.connect();
    const db = mongoClient.db();
    const profile = await db.collection('voice_profiles').findOne({ profileId: 'channel_voice_v1' });
    await mongoClient.close();
    return profile;
  } catch (error) {
    if (mongoClient) await mongoClient.close().catch(() => {});

    // Fallback: try port-forwarded MongoDB
    try {
      const fallbackUri = 'mongodb://admin:p4ssw0rdn3w@localhost:27017/discord?authSource=admin';
      mongoClient = new MongoClient(fallbackUri);
      await mongoClient.connect();
      const db = mongoClient.db();
      const profile = await db.collection('voice_profiles').findOne({ profileId: 'channel_voice_v1' });
      await mongoClient.close();
      return profile;
    } catch {
      console.error('Cannot connect to MongoDB. Port-forward it: kubectl port-forward svc/mongodb 27017:27017 -n discord-article-bot');
      return null;
    }
  }
}

/**
 * Sample real messages from channel_conversations for test prompts
 */
async function sampleTestMessages(count) {
  try {
    const response = await qdrant.scroll('channel_conversations', {
      limit: count * 5,
      with_payload: true,
      with_vector: false
    });

    // Filter to substantive messages (>20 chars, not URLs)
    const candidates = (response.points || [])
      .filter(p => {
        const content = p.payload.content || '';
        return content.length > 20 &&
               !content.startsWith('http') &&
               !content.startsWith('<') &&
               content.split(' ').length >= 4;
      });

    // Shuffle and take count
    for (let i = candidates.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
    }

    return candidates.slice(0, count).map(p => ({
      author: p.payload.authorName,
      content: p.payload.content
    }));
  } catch (error) {
    console.error(`Failed to sample messages from Qdrant: ${error.message}`);
    console.error('Make sure Qdrant is port-forwarded: kubectl port-forward svc/qdrant 6333:6333 -n discord-article-bot');
    return [];
  }
}

/**
 * Fetch few-shot examples from IRC history via semantic search
 */
async function getFewShotExamples(query) {
  try {
    // Generate embedding for the query
    const embResponse = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: query
    });

    const results = await qdrant.search('irc_history', {
      vector: embResponse.data[0].embedding,
      limit: 3,
      score_threshold: 0.25,
      with_payload: true
    });

    if (results.length === 0) return '';

    const examples = results.map(r => {
      const lines = (r.payload.text || '').split('\n').slice(0, 3).join('\n');
      return lines;
    }).filter(Boolean);

    return `\n\nReal conversation examples showing the group's style (use as tone/style reference, not content):\n${examples.map(t => `\`\`\`\n${t}\n\`\`\``).join('\n')}`;
  } catch {
    return '';
  }
}

/**
 * Build the channel-voice system prompt with voice profile injected
 */
function buildChannelVoicePrompt(voiceProfile, fewShotBlock = '') {
  let prompt = channelVoicePersonality.systemPrompt;
  prompt = prompt.replace('{VOICE_INSTRUCTIONS}', voiceProfile.voiceInstructions);

  return `${prompt}

You are in a group conversation with multiple users in a Discord channel.
Their names appear before their messages like "[Username]: message".
Address users by name when relevant.${fewShotBlock}`;
}

/**
 * Build the friendly system prompt (control)
 */
function buildFriendlyPrompt() {
  return `${friendlyPersonality.systemPrompt}

You are in a group conversation with multiple users in a Discord channel.
Their names appear before their messages like "[Username]: message".
Address users by name when relevant.`;
}

/**
 * Generate a response from a given system prompt
 */
async function generateResponse(systemPrompt, userMessage) {
  const response = await openai.responses.create({
    model: MODEL,
    instructions: systemPrompt,
    input: `User: [TestUser]: ${userMessage}`
  });
  return {
    text: response.output_text,
    tokens: {
      input: response.usage?.input_tokens || 0,
      output: response.usage?.output_tokens || 0
    }
  };
}

// ==================== Main ====================

async function main() {
  console.log(`\n${'═'.repeat(70)}`);
  console.log('  A/B Comparison: Channel Voice vs. Friendly');
  console.log(`  Model: ${MODEL}`);
  console.log(`${'═'.repeat(70)}\n`);

  // Load voice profile
  console.log('Loading voice profile from MongoDB...');
  const voiceProfile = await loadVoiceProfile();
  if (!voiceProfile) {
    console.error('No voice profile found. Run the bot first to generate one.');
    process.exit(1);
  }
  console.log(`Loaded voice profile v${voiceProfile.version} (${voiceProfile.generatedAt})\n`);

  // Get test messages
  let testMessages;
  if (CUSTOM_MESSAGE) {
    testMessages = [{ author: 'TestUser', content: CUSTOM_MESSAGE }];
  } else {
    console.log(`Sampling ${SAMPLE_COUNT} real messages from channel history...`);
    testMessages = await sampleTestMessages(SAMPLE_COUNT);
    if (testMessages.length === 0) {
      console.error('No test messages could be sampled.');
      process.exit(1);
    }
    console.log(`Got ${testMessages.length} test messages\n`);
  }

  const friendlyPrompt = buildFriendlyPrompt();
  let totalCost = { styledInput: 0, styledOutput: 0, controlInput: 0, controlOutput: 0 };

  for (let i = 0; i < testMessages.length; i++) {
    const msg = testMessages[i];
    const userMessage = msg.content;

    console.log(`${'─'.repeat(70)}`);
    console.log(`  [${i + 1}/${testMessages.length}] ${msg.author}: ${userMessage}`);
    console.log(`${'─'.repeat(70)}`);

    // Get few-shot examples for this message
    const fewShotBlock = await getFewShotExamples(userMessage);
    const channelVoicePrompt = buildChannelVoicePrompt(voiceProfile, fewShotBlock);

    // Run both in parallel
    const [styledResult, controlResult] = await Promise.all([
      generateResponse(channelVoicePrompt, userMessage),
      generateResponse(friendlyPrompt, userMessage)
    ]);

    totalCost.styledInput += styledResult.tokens.input;
    totalCost.styledOutput += styledResult.tokens.output;
    totalCost.controlInput += controlResult.tokens.input;
    totalCost.controlOutput += controlResult.tokens.output;

    console.log(`\n  🗣️  Channel Voice:`);
    console.log(`  ${styledResult.text.split('\n').join('\n  ')}`);
    console.log(`\n  😊 Friendly:`);
    console.log(`  ${controlResult.text.split('\n').join('\n  ')}`);
    console.log();
  }

  // Summary
  console.log(`${'═'.repeat(70)}`);
  console.log('  Token Usage Summary');
  console.log(`${'═'.repeat(70)}`);
  console.log(`  Channel Voice: ${totalCost.styledInput} input + ${totalCost.styledOutput} output = ${totalCost.styledInput + totalCost.styledOutput} total`);
  console.log(`  Friendly:      ${totalCost.controlInput} input + ${totalCost.controlOutput} output = ${totalCost.controlInput + totalCost.controlOutput} total`);
  console.log(`  Overhead:      ${((totalCost.styledInput + totalCost.styledOutput) / (totalCost.controlInput + totalCost.controlOutput) * 100 - 100).toFixed(1)}% more tokens for styled responses`);
  console.log();
}

main().catch(err => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
