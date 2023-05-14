import { z } from 'zod';

import { createTRPCRouter, publicProcedure } from '~/modules/trpc/trpc.server';

import { OpenAI } from '../../openai/openai.types';


const accessSchema = z.object({
  oaiKey: z.string().trim(),
  oaiOrg: z.string().trim(),
  oaiHost: z.string().trim(),
  heliKey: z.string().trim(),
});

const modelSchema = z.object({
  id: z.string(),
  temperature: z.number().min(0).max(1).optional(),
  maxTokens: z.number().min(1).max(100000).optional(),
});

const historySchema = z.array(z.object({
  role: z.enum(['assistant', 'system', 'user']),
  content: z.string(),
}));


export const openAIRouter = createTRPCRouter({

  /**
   * List the Models available
   */
  listModels: publicProcedure
    .input(accessSchema)
    .query(async ({ input }): Promise<OpenAI.Wire.Models.ModelDescription[]> => {

      let wireModels: OpenAI.Wire.Models.Response;
      wireModels = await openaiGET<OpenAI.Wire.Models.Response>(input, '/v1/models');

      // filter out the non-gpt models
      const llms = wireModels.data?.filter(model => model.id.includes('gpt')) ?? [];

      // sort by which model has the least number of '-' in the name, and then by id, decreasing
      llms.sort((a, b) => {
        const aCount = a.id.split('-').length;
        const bCount = b.id.split('-').length;
        if (aCount === bCount)
          return b.id.localeCompare(a.id);
        return aCount - bCount;
      });

      return llms;
    }),

  /**
   * Chat generation
   */
  chatGenerate: publicProcedure
    .input(z.object({ access: accessSchema, model: modelSchema, history: historySchema }))
    .mutation(async ({ input: { access, model, history } }): Promise<OpenAI.API.Chat.Response> => {

      const requestBody: OpenAI.Wire.Chat.CompletionRequest = openAICompletionRequest(model, history, false);
      let response: OpenAI.Wire.Chat.CompletionResponse;

      try {
        response = await openaiPOST<OpenAI.Wire.Chat.CompletionRequest, OpenAI.Wire.Chat.CompletionResponse>(access, requestBody, '/v1/chat/completions');
      } catch (error: any) {
        // don't log 429 errors, they are expected
        if (!error || !(typeof error.startsWith === 'function') || !error.startsWith('Error: 429 · Too Many Requests'))
          console.error('api/openai/chat error:', error);
        throw error;
      }

      if (response?.choices?.length !== 1)
        throw new Error(`Expected 1 choice, got ${response?.choices?.length}`);

      const singleChoice = response.choices[0];
      return {
        role: singleChoice.message.role,
        content: singleChoice.message.content,
        finish_reason: singleChoice.finish_reason,
      };
    }),

});


type AccessSchema = z.infer<typeof accessSchema>;
type ModelSchema = z.infer<typeof modelSchema>;
type HistorySchema = z.infer<typeof historySchema>;

async function openaiGET<TOut>(access: AccessSchema, apiPath: string /*, signal?: AbortSignal*/): Promise<TOut> {
  const { headers, url } = openAIAccess(access, apiPath);
  const response = await fetch(url, { headers });
  return await response.json() as TOut;
}

async function openaiPOST<TBody, TOut>(access: AccessSchema, body: TBody, apiPath: string /*, signal?: AbortSignal*/): Promise<TOut> {
  const { headers, url } = openAIAccess(access, apiPath);
  const response = await fetch(url, { headers, method: 'POST', body: JSON.stringify(body) });
  return await response.json() as TOut;
}

function openAIAccess(access: AccessSchema, apiPath: string): { headers: HeadersInit, url: string } {
  // API key
  const oaiKey = access.oaiKey || process.env.OPENAI_API_KEY || '';
  if (!oaiKey) throw new Error('Missing OpenAI API Key. Add it on the client side (Settings icon) or server side (your deployment).');

  // Organization ID
  const oaiOrg = access.oaiOrg || process.env.OPENAI_API_ORG_ID || '';

  // API host
  let oaiHost = access.oaiHost || process.env.OPENAI_API_HOST || 'https://api.openai.com';
  if (!oaiHost.startsWith('http'))
    oaiHost = `https://${oaiHost}`;
  if (oaiHost.endsWith('/') && apiPath.startsWith('/'))
    oaiHost = oaiHost.slice(0, -1);

  // Helicone key
  const heliKey = access.heliKey || process.env.HELICONE_API_KEY || '';

  return {
    headers: {
      Authorization: `Bearer ${oaiKey}`,
      'Content-Type': 'application/json',
      ...(oaiOrg && { 'OpenAI-Organization': oaiOrg }),
      ...(heliKey && { 'Helicone-Auth': `Bearer ${heliKey}` }),
    },
    url: oaiHost + apiPath,
  };
}

function openAICompletionRequest(model: ModelSchema, history: HistorySchema, stream: boolean): OpenAI.Wire.Chat.CompletionRequest {
  return {
    model: model.id,
    messages: history,
    ...(model.temperature && { temperature: model.temperature }),
    ...(model.maxTokens && { max_tokens: model.maxTokens }),
    stream,
    n: 1,
  };
}