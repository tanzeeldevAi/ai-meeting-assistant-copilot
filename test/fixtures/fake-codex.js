#!/usr/bin/env node
'use strict';
/*
 * Stands in for the Codex CLI in tests. Reads the prompt from stdin, like the
 * real `codex exec ... -`, and answers in the same JSONL event format.
 *
 * Behaviour is chosen by a marker in the prompt:
 *   FAIL_LOGIN  -> a turn.failed saying the user is not logged in
 *   SLOW        -> waits 5 s before answering (for abort tests)
 *   anything    -> answers "heard <n> characters"
 */
const args = process.argv.slice(2);
if (args[0] === 'login' && args[1] === 'status') {
  if (process.env.FAKE_CODEX_STATE === 'out') {
    process.stdout.write('Not logged in\n');
    process.exit(1);
  }
  process.stdout.write('Logged in using ChatGPT\n');
  process.exit(0);
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  const emit = (e) => process.stdout.write(JSON.stringify(e) + '\n');
  emit({ type: 'thread.started', thread_id: 'test' });
  emit({ type: 'turn.started' });
  if (!args.includes('exec') || args[args.length - 1] !== '-') {
    emit({ type: 'turn.failed', error: { message: 'expected: exec ... -' } });
    process.exit(1);
  }
  if (input.includes('FAIL_LOGIN')) {
    emit({ type: 'turn.failed', error: { message: 'You are not logged in. Run codex login.' } });
    process.exit(1);
  }
  const answer = () => {
    emit({ type: 'item.completed', item: { type: 'agent_message', text: `heard ${input.length} characters` } });
    emit({ type: 'turn.completed' });
  };
  if (input.includes('SLOW')) setTimeout(answer, 5000);
  else answer();
});
