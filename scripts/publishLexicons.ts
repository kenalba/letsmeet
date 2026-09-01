import { AtpAgent } from '@atproto/api';
import scheduleLex from '../lexicons/cool.wzrdz.poll.schedule.json' with { type: 'json' };
import responseLex from '../lexicons/cool.wzrdz.poll.response.json' with { type: 'json' };

const { LEX_HANDLE, LEX_APP_PASSWORD, LEX_PDS = 'https://bsky.social' } = process.env;
if (!LEX_HANDLE || !LEX_APP_PASSWORD) {
  console.error('Set LEX_HANDLE and LEX_APP_PASSWORD (an app password for the wzrdz.cool account).');
  process.exit(1);
}

const agent = new AtpAgent({ service: LEX_PDS });
await agent.login({ identifier: LEX_HANDLE, password: LEX_APP_PASSWORD });

for (const lex of [scheduleLex, responseLex]) {
  const res = await agent.com.atproto.repo.putRecord({
    repo: agent.session!.did,
    collection: 'com.atproto.lexicon.schema',
    rkey: lex.id,
    record: { ...lex, $type: 'com.atproto.lexicon.schema' },
  });
  console.log(`published ${lex.id} -> ${res.data.uri}`);
}
