import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RepairBudget } from '../src/modules/ai/pipeline/types.js';

test('política de correções do turno: no máximo uma estrutural e uma semântica', () => {
  const clean = new RepairBudget();
  assert.equal(clean.canUse('omission'), true);
  assert.equal(clean.canUse('validation'), true);
  assert.equal(clean.reported(), 0);

  const structural = new RepairBudget();
  structural.consume('structural');
  assert.equal(structural.canUse('structural'), false, 'uma única correção estrutural');
  assert.equal(structural.canUse('omission'), false, 'omissão só em turno sem outra correção');
  assert.equal(structural.canUse('validation'), true, 'estrutural não bloqueia a correção de validação');

  const omission = new RepairBudget();
  omission.consume('omission');
  assert.equal(omission.canUse('validation'), false, 'uma correção semântica por turno');
  assert.equal(omission.reported(), 1);

  const repeated = new RepairBudget();
  repeated.consume('repeated-question');
  assert.equal(repeated.canUse('omission'), false);
  assert.equal(repeated.canUse('validation'), false);

  const validation = new RepairBudget();
  validation.consume('structural');
  validation.consume('validation');
  assert.equal(validation.reported(), 1, 'contrato v1: repairAttempts máximo 1 quando houve correção de validação');
});
