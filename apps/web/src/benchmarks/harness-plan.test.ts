import assert from 'node:assert/strict';
import test from 'node:test';
import { harnessEvidenceFiles, harnessPlan } from './harness-plan.ts';

function byPath(items: { path: string; purpose: string }[]) {
  return items
    .map(({ path, purpose }) => ({ path, purpose }))
    .toSorted((a, b) => a.path.localeCompare(b.path, 'en'));
}

void test('the design has 24 specified tasks with balanced families, stacks, and estimated difficulty', () => {
  const { tasks, task_set: set, workloads } = harnessPlan;
  assert.equal(tasks.length, 24);
  assert.equal(set.planned_tasks, tasks.length);
  assert.equal(new Set(tasks.map((task) => task.id)).size, tasks.length);
  assert.equal(set.workspaces.length, set.planned_workspaces);
  const gateIds = tasks.flatMap((task) => task.acceptance.map((gate) => gate.id));
  assert.equal(new Set(gateIds).size, 72);
  for (const task of tasks) {
    const workspace = set.workspaces.find((item) => item.id === task.workspace_id);
    assert.ok(workspace, `${task.id}: workspace is declared`);
    assert.equal(task.stack, workspace.stack);
    assert.equal(task.acceptance.length, 3);
    assert.equal(task.status, 'specified_not_built');
    assert.equal(task.difficulty_status, 'estimated_not_measured');
    assert.ok(task.prompt && task.difficulty_reason && task.deliverables.length);
    for (const gate of task.acceptance) assert.ok(gate.name && gate.criterion);
  }
  for (const workspace of set.workspaces)
    assert.equal(tasks.filter((task) => task.workspace_id === workspace.id).length, 2);
  for (const level of set.difficulty_levels)
    assert.equal(tasks.filter((task) => task.difficulty === level.id).length, level.planned_tasks);
  assert.deepEqual(
    set.difficulty_levels.map((level) => level.planned_tasks),
    [6, 12, 6],
  );
  for (const family of workloads) {
    assert.equal(tasks.filter((task) => task.workload_id === family.id).length, 6);
    for (const stack of set.strata)
      assert.equal(
        tasks.filter((task) => task.workload_id === family.id && task.stack === stack.name).length,
        2,
      );
  }
  for (const stack of set.strata)
    assert.equal(tasks.filter((task) => task.stack === stack.name).length, 8);
});

void test('planned attempts and cash allocations reconcile without presenting execution evidence', () => {
  const { task_set: set, budget, harnesses, qualification } = harnessPlan;
  assert.equal(
    set.planned_scored_attempts,
    set.planned_tasks * harnesses.length * set.repetitions_per_task,
  );
  for (const phase of budget.phases)
    assert.equal(phase.ceiling_usd, phase.units * phase.usd_per_unit);
  assert.equal(
    budget.phases.find((phase) => phase.name === 'Main cohort')?.units,
    set.planned_scored_attempts,
  );
  assert.equal(
    budget.api_ceiling,
    budget.phases.reduce((total, phase) => total + phase.ceiling_usd, 0),
  );
  assert.equal(budget.total_cash_ceiling_before_tax, budget.api_ceiling + budget.compute_ceiling);
  assert.equal(harnessPlan.status, 'design_only');
  assert.equal(qualification.status, 'not_run');
  assert.equal(set.validated_packages, 0);
  assert.equal(set.measured_attempts, 0);
  assert.ok(harnesses.every((harness) => harness.qualification_status === 'not_run'));
});

void test('readable evidence labels preserve every required file and its exact contract', () => {
  assert.deepEqual(byPath(harnessEvidenceFiles), byPath(harnessPlan.artifacts));
  assert.ok(harnessEvidenceFiles.every((file) => file.name && file.name !== file.path));
  assert.deepEqual(
    harnessEvidenceFiles.map((file) => file.name),
    harnessEvidenceFiles.map((file) => file.name).toSorted((a, b) => a.localeCompare(b, 'en')),
  );
});
