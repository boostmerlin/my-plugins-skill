import test from 'node:test';
import assert from 'node:assert/strict';
import * as m from './manage-skills.mjs';
import { parseChoice } from './catalog.mjs';

function catalog() {
  const entry = (name, extra = {}) => ({ package: `owner/${name}`, names: [name], profiles: ['docs'], scope: 'global', agents: ['detected'], required: false, reviewed: true, ...extra });
  return { schemaVersion: 1, defaultProfiles: ['docs'], profiles: { docs: {}, other: {} }, skills: [
    entry('a', { names: ['a', 'a-extra'], exclusiveGroup: 'writing', defaultInExclusiveGroup: true }),
    entry('b', { exclusiveGroup: 'writing' }), entry('common'),
  ] };
}
const installed = (name, agents = ['codex']) => ({ name, agents, scope: 'global' });

test('entry validation rejects malformed groups and mismatched scope', () => {
  for (const edit of [c => c.skills.pop() && c.skills.pop(), c => c.skills[1].defaultInExclusiveGroup = true,
    c => delete c.skills[0].defaultInExclusiveGroup, c => c.skills[1].scope = 'project',
    c => c.skills[0].exclusiveGroup = ' ', c => c.skills[2].defaultInExclusiveGroup = false,
    c => c.skills[0].defaultInExclusiveGroup = 'true']) {
    const c = catalog(); edit(c); assert.throws(() => m.validateCatalog(c));
  }
});

test('selection defaults, overrides whole entries, and rejects unavailable choices', () => {
  const c = m.validateCatalog(catalog());
  assert.deepEqual(m.buildPlan(c, ['docs'], [], ['codex']).map(x => x.skill.name), ['a', 'a-extra', 'common']);
  assert.deepEqual(m.buildPlan(c, ['docs'], [], ['codex'], { choices: ['writing=b'].map(parseChoice) }).map(x => x.skill.name), ['b', 'common']);
  for (const choices of [['bad=b'], ['writing=bad'], ['writing=a', 'writing=b']])
    assert.throws(() => m.buildPlan(c, ['docs'], [], ['codex'], { choices: choices.map(parseChoice) }));
  c.skills[1].profiles = ['other'];
  assert.throws(() => m.buildPlan(c, ['docs'], [], ['codex'], { choices: ['writing=b'].map(parseChoice) }));
  assert.deepEqual(m.buildPlan(c, ['other'], [], ['codex']).map(x => x.skill.name), ['b']);
});

test('choose command restrictions and repeats', () => {
  assert.deepEqual(m.parseArgs(['plan', '--choose', 'writing=b', '--choose', 'writing=b']).choices, ['writing=b', 'writing=b'].map(parseChoice));
  for (const command of ['install', 'remove', 'sources', 'doctor', 'audit'])
    assert.throws(() => m.parseArgs([command, '--all', '--choose', 'writing=b']));
  assert.doesNotThrow(() => m.parseArgs(['audit', '--profile', 'docs', '--choose', 'writing=b']));
});

test('audit reports alternate as conflict but full catalog audit includes all', () => {
  const c = catalog(); const items = ['b', 'common'].map(n => installed(n));
  const selected = m.buildAuditFindings(c, ['docs'], items, ['codex'], { profileAudit: true, choices: ['writing=b'].map(parseChoice) });
  assert.deepEqual(selected.drift, []);
  assert.ok(m.buildAuditFindings(c, ['docs'], [...items, installed('a')], ['codex'], { profileAudit: true, choices: ['writing=b'].map(parseChoice) }).drift.some(x => x.includes('[CONFLICT]')));
  assert.equal(m.buildAuditFindings(c, ['docs'], items, ['codex']).expected.length, 4);
});

test('sync verifies replacement before cleanup, isolates agents, and reports residuals', async () => {
  for (const outcome of ['success', 'install-failure', 'verification-failure', 'residual']) {
    const c = catalog(); c.skills[0].agents = ['codex', 'claude-code']; c.skills[1].agents = ['codex', 'claude-code'];
    let items = [installed('a', ['codex', 'claude-code']), installed('common')]; const calls = [];
    const result = await m.executeSkillOperation(m.parseArgs(['sync', '--profile', 'docs', '--choose', 'writing=b', '--agent', 'codex', '--yes']), {
      catalog: c, detectActiveAgents: () => ['codex'], listInstalled: () => items,
      runSkills: args => {
        calls.push(args);
        if (args[0] === 'add') {
          if (outcome === 'install-failure') return { status: 1 };
          if (outcome !== 'verification-failure') items.push(installed('b', ['codex', 'claude-code']), installed('common'));
        } else if (outcome !== 'residual') items = items.map(x => x.name === 'a' ? installed('a', ['claude-code']) : x);
        return { status: 0 };
      },
    });
    const removals = calls.filter(x => x[0] === 'remove');
    assert.equal(removals.length, ['success', 'residual'].includes(outcome) ? 1 : 0);
    if (removals.length) assert.deepEqual(removals[0], ['remove', 'a', '--agent', 'codex', '--yes', '--global']);
    assert.equal(result.failed, outcome !== 'success');
  }
});

test('install keeps all entries and invalid choose fails before discovery', async () => {
  const names = [];
  await m.executeSkillOperation(m.parseArgs(['install', '--profile', 'docs', '--yes']), { catalog: catalog(), detectActiveAgents: () => ['codex'], listInstalled: () => [], runSkills: args => { names.push(...args.slice(3, args.indexOf('--agent'))); return { status: 0 }; } });
  assert.deepEqual(names, ['a', 'a-extra', 'b', 'common']);
  await assert.rejects(() => m.executeSkillOperation(m.parseArgs(['plan', '--profile', 'docs', '--choose', 'writing=unknown']), { catalog: catalog(), detectActiveAgents: () => assert.fail('discovery called'), listInstalled: () => assert.fail('list called') }));
});

test('multiple entry groups select independently from profile groups and deduplicate cleanup', () => {
  const c = catalog();
  c.profiles.docs = { exclusiveGroup: 'writing', defaultInExclusiveGroup: true };
  c.profiles.other = { exclusiveGroup: 'writing' };
  c.skills[1].profiles = ['other'];
  c.skills.push({ ...c.skills[0], names: ['x'], exclusiveGroup: 'second' }, { ...c.skills[1], names: ['y'], profiles: ['docs'], exclusiveGroup: 'second' });
  m.validateCatalog(c);
  assert.deepEqual(m.buildPlan(c, ['docs'], [], ['codex'], { choices: ['second=y'].map(parseChoice) }).map(x => x.skill.name), ['a', 'a-extra', 'common', 'y']);
  const cleanup = m.buildCleanupPlan(c, ['docs'], [installed('b'), installed('unmanaged')], ['codex']);
  assert.equal(cleanup.length, 1);
  assert.equal(cleanup[0].skill.name, 'b');
  assert.deepEqual(cleanup[0].agents, ['codex']);
});

test('missing default among multiple candidates requires choose', () => {
  const c = catalog(); c.skills[0].profiles = ['other'];
  c.skills.push({ ...c.skills[1], names: ['c'] });
  assert.throws(() => m.buildPlan(c, ['docs'], [], ['codex']), /Default.*outside/);
  assert.deepEqual(m.buildPlan(c, ['docs'], [], ['codex'], { choices: ['writing=c'].map(parseChoice) }).map(x => x.skill.name), ['common', 'c']);
});

test('parsed choices preserve aliases, conflict detection, whitespace and special group names', () => {
  for (const group of ['writing', '__proto__', 'constructor']) {
    const c = catalog();
    c.skills[0].exclusiveGroup = group; c.skills[1].exclusiveGroup = group;
    const choices = m.parseArgs(['plan', '--choose', ` ${group} = a `, '--choose', `${group}=A-EXTRA`]).choices;
    assert.deepEqual(m.buildPlan(c, ['docs'], [], ['codex'], { choices }).map(x => x.skill.name), ['a', 'a-extra', 'common']);
    assert.throws(() => m.buildPlan(c, ['docs'], [], ['codex'], { choices: [...choices, parseChoice(`${group}=b`)] }), /Conflicting/);
  }
  assert.throws(() => m.parseArgs(['plan', '--choose', '--bad=a']), /choose/);
});

test('profile validation and selection reject inherited names but allow explicitly declared special names', () => {
  for (const name of ['toString', 'constructor', '__proto__']) {
    const c = catalog();
    assert.throws(() => m.selectProfiles(c, [name]), /Unknown profile/);
    c.defaultProfiles = [name];
    assert.throws(() => m.validateCatalog(c), /Unknown default profile/);
    c.defaultProfiles = ['docs']; c.skills[0].profiles = [name];
    assert.throws(() => m.validateCatalog(c), /unknown profile/);
    Object.defineProperty(c.profiles, name, { value: {}, enumerable: true });
    assert.doesNotThrow(() => m.validateCatalog(c));
    assert.deepEqual(m.selectProfiles(c, [name]), [name]);
  }
});

test('audit can reuse an already resolved selection', () => {
  const c = catalog();
  const selection = { entries: [c.skills[1], c.skills[2]], groups: new Map() };
  const result = m.buildAuditFindings(c, ['docs'], [installed('b'), installed('common')], ['codex'], { profileAudit: true, selection });
  assert.deepEqual(result.expected.map(x => x.name), ['b', 'common']);
  assert.deepEqual(result.drift, []);
});

test('cleanup protects local, unrelated and nonoverlapping agent entries', () => {
  const c = catalog(); c.skills[1].package = './local';
  let cleanup = m.buildCleanupPlan(c, ['docs'], [installed('b'), installed('unmanaged')], ['codex']);
  assert.equal(cleanup.length, 1); assert.equal(cleanup[0].action, 'skip');
  c.skills[1].agents = ['claude-code'];
  cleanup = m.buildCleanupPlan(c, ['docs'], [installed('b', ['codex', 'claude-code'])], ['codex']);
  assert.deepEqual(cleanup, []);
});

test('selected local alternative blocks replacement without any mutation', async () => {
  const c = catalog(); c.skills[0].package = './local';
  await assert.rejects(() => m.executeSkillOperation(m.parseArgs(['sync', '--profile', 'docs', '--yes']), {
    catalog: c, detectActiveAgents: () => ['codex'], listInstalled: () => [installed('b')], runSkills: () => assert.fail('must not mutate'),
  }), /local source/);
});

test('profile-only cleanup also requires verified replacements', async () => {
  const calls = [];
  const c = catalog();
  delete c.skills[0].exclusiveGroup; delete c.skills[0].defaultInExclusiveGroup; delete c.skills[1].exclusiveGroup;
  c.profiles.docs = { exclusiveGroup: 'workflow', defaultInExclusiveGroup: true };
  c.profiles.other = { exclusiveGroup: 'workflow' }; c.skills[1].profiles = ['other'];
  const result = await m.executeSkillOperation(m.parseArgs(['sync', '--profile', 'docs', '--yes']), {
    catalog: c, detectActiveAgents: () => ['codex'], listInstalled: () => [installed('b')],
    runSkills: args => { calls.push(args[0]); return { status: 0 }; },
  });
  assert.equal(result.failed, true); assert.ok(!calls.includes('remove'));
});

test('required local common skill prevents entry cleanup', async () => {
  const c = catalog(); c.skills[2].package = './local'; c.skills[2].required = true;
  await assert.rejects(() => m.executeSkillOperation(m.parseArgs(['sync', '--profile', 'docs', '--yes']), {
    catalog: c, detectActiveAgents: () => ['codex'], listInstalled: () => [installed('b')], runSkills: () => assert.fail('must not mutate'),
  }), /local source/);
});

test('profile audit reports protected local alternate as a conflict', () => {
  const c = catalog(); c.skills[1].package = './local';
  const result = m.buildAuditFindings(c, ['docs'], ['a', 'a-extra', 'b', 'common'].map(n => installed(n)), ['codex'], { profileAudit: true });
  assert.ok(result.drift.some(line => line.includes('[CONFLICT] global:b')));
});

test('profile cleanup respects replacement and peer agent targets', () => {
  const c = catalog();
  delete c.skills[0].exclusiveGroup; delete c.skills[0].defaultInExclusiveGroup; delete c.skills[1].exclusiveGroup;
  c.profiles.docs = { exclusiveGroup: 'workflow', defaultInExclusiveGroup: true };
  c.profiles.other = { exclusiveGroup: 'workflow' }; c.skills[1].profiles = ['other'];
  c.skills[0].agents = ['claude-code']; c.skills[2].profiles = ['other'];
  assert.deepEqual(m.buildCleanupPlan(c, ['docs'], [installed('b')], ['codex']), []);
  c.skills[0].agents = ['codex']; c.skills[1].agents = ['claude-code'];
  assert.deepEqual(m.buildCleanupPlan(c, ['docs'], [installed('b')], ['codex']), []);
});
