// services/VoiceSearchService.js
// Voice-informed search: query expansion + voice-styled synthesis for IRC history

const logger = require('../logger');
const { DEFAULT_OPENAI_MODEL, reasoningParams } = require('../utils/openaiModels');

class VoiceSearchService {
  /**
   * @param {Object} qdrantService - QdrantService for IRC history search
   * @param {Object} voiceProfileService - VoiceProfileService for vocabulary and voice styling
   * @param {Object} openaiClient - OpenAI client for LLM calls
   * @param {Object} config - Bot configuration
   */
  constructor(qdrantService, voiceProfileService, openaiClient, config) {
    this.qdrantService = qdrantService;
    this.voiceProfileService = voiceProfileService;
    this.openaiClient = openaiClient;
    this.config = config;
  }

  /**
   * Expand a search query using vocabulary from the voice profile
   * @param {string} query - Original search query
   * @returns {Promise<string[]>} Array of expanded query variants (includes original)
   */
  async expandQuery(query) {
    try {
      // Get vocabulary from voice profile
      const profile = await this.voiceProfileService?.getProfile().catch(() => null);
      const vocabulary = profile?.vocabulary || [];

      const instruction = `You are a search query expander. Given a search query and a list of slang/vocabulary that a group of friends uses, generate 2-3 alternative phrasings of the query using their language.

Return ONLY a JSON array of strings. Include variations using their vocabulary where relevant. Keep each variant under 50 characters.

Example: query "server went down", vocabulary ["prod", "rip", "oof"]
Output: ["prod went down", "server crashed rip", "server outage"]`;

      const input = `Query: "${query}"${vocabulary.length > 0 ? `\nGroup vocabulary: ${vocabulary.join(', ')}` : ''}`;

      const model = this.config.openai.model || DEFAULT_OPENAI_MODEL;
      const response = await this.openaiClient.responses.create({
        model,
        instructions: instruction,
        input,
        ...reasoningParams(model, 'none')
      });

      let variants;
      try {
        // Parse JSON array from response, stripping any markdown fencing
        const cleaned = response.output_text.replace(/```json?\n?|\n?```/g, '').trim();
        variants = JSON.parse(cleaned);
      } catch {
        // If parsing fails, split by newlines
        variants = response.output_text.split('\n').map(s => s.replace(/^[-*"\d.]+\s*/, '').trim()).filter(Boolean);
      }

      // Always include the original query
      if (!variants.includes(query)) {
        variants.unshift(query);
      }

      logger.info(`Query expansion: "${query}" → [${variants.join(', ')}]`);
      return variants;

    } catch (error) {
      logger.error(`Query expansion failed: ${error.message}`);
      return [query];
    }
  }

  /**
   * Search with expanded queries, merge and deduplicate results
   * @param {string} query - Original search query
   * @param {Object} searchOptions - Qdrant search options (year, participants, etc.)
   * @returns {Promise<Array>} Deduplicated, score-sorted results
   */
  async searchWithExpansion(query, searchOptions) {
    const expandedQueries = await this.expandQuery(query);

    // Search all variants in parallel
    const searchPromises = expandedQueries.map(q =>
      this.qdrantService.search(q, { ...searchOptions, limit: 5 })
        .catch(err => {
          logger.debug(`Search failed for variant "${q}": ${err.message}`);
          return [];
        })
    );

    const allResults = await Promise.all(searchPromises);

    // Merge and deduplicate by point ID, keeping highest score
    const deduped = new Map();
    for (const results of allResults) {
      for (const result of results) {
        const existing = deduped.get(result.id);
        if (!existing || result.score > existing.score) {
          deduped.set(result.id, result);
        }
      }
    }

    // Sort by score descending
    const merged = Array.from(deduped.values()).sort((a, b) => b.score - a.score);

    logger.info(`Voice search: ${expandedQueries.length} queries → ${allResults.flat().length} raw results → ${merged.length} deduplicated`);
    return merged.slice(0, searchOptions.limit || 5);
  }

  /**
   * Synthesize search results into a voice-styled narrative summary
   * @param {string} query - Original search query
   * @param {Array} results - Qdrant search results
   * @returns {Promise<string|null>} Voice-styled summary or null on error
   */
  async synthesizeResults(query, results) {
    if (!results || results.length === 0) return null;

    try {
      const profile = await this.voiceProfileService?.getProfile().catch(() => null);

      // Build compact context from results
      const resultsContext = results.map(r => {
        const p = r.payload;
        const date = p.start_time ? new Date(p.start_time).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }) : (p.year || '');
        return `[${date} - ${p.channel || ''}]\n${p.text}`;
      }).join('\n\n');

      let instruction = `You are summarizing IRC conversation search results for a user who asked: "${query}"

RULES:
- ONLY reference content that appears in the provided conversation logs
- Synthesize the results into a brief, natural narrative (2-4 sentences)
- Mention who said what and when
- Do NOT invent details not present in the logs`;

      if (profile) {
        instruction += `\n\nStyle your response to match this group's communication style:\n${profile.voiceInstructions || ''}`;
        if (profile.toneKeywords?.length > 0) {
          instruction += `\nTone: ${profile.toneKeywords.join(', ')}`;
        }
      }

      const model = this.config.openai.model || DEFAULT_OPENAI_MODEL;
      const response = await this.openaiClient.responses.create({
        model,
        instructions: instruction,
        input: resultsContext,
        ...reasoningParams(model, 'low')
      });

      logger.info(`Voice synthesis: ${response.usage?.input_tokens || 0} input, ${response.usage?.output_tokens || 0} output tokens`);
      return response.output_text.trim();

    } catch (error) {
      logger.error(`Voice synthesis failed: ${error.message}`);
      return null;
    }
  }
}

module.exports = VoiceSearchService;
