const BASE = 'http://localhost:3000';

async function api(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(BASE + path, opts);
  const data = await res.json();
  return { status: res.status, ...data };
}

function check(name, cond, detail) {
  console.log(`  ${cond ? '✓' : '✗'} ${name}${detail ? ' - ' + detail : ''}`);
  if (!cond) process.exitCode = 1;
}

async function test() {
  console.log('========== 三个 Bug 专项修复验证 ==========\n');
  const uid = 'bugfix_' + Date.now();
  const daysAgo = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString(); };

  for (let i = 0; i < 5; i++) {
    await api('POST', '/api/inventory/report', {
      userId: uid, productId: 'sanitary_pad_regular',
      quantity: 40 - i * 6, cyclePhase: i === 0 ? 'menstrual' : 'follicular',
      timestamp: daysAgo(35 - i * 7)
    });
  }
  for (let i = 0; i < 5; i++) {
    await api('POST', '/api/inventory/report', {
      userId: uid, productId: 'tampon_regular',
      quantity: 30 - i * 4, cyclePhase: i === 0 ? 'menstrual' : 'luteal',
      timestamp: daysAgo(35 - i * 7)
    });
  }
  console.log('  已上报基础数据（2种产品各5条）\n');

  console.log('【Bug1】未设置 globalMaxBudget 时，预算汇总不应显示为 0');
  await api('PUT', `/api/subscription/${uid}/config`, {
    enabled: true, cyclesAhead: 1,
    globalMaxBudget: null
  });
  let r = await api('GET', `/api/subscription/${uid}/plan/preview`);
  const budget = r.data?.plan?.cycles?.[0]?.budgetSummary;
  console.log(`    budgetSummary.maxBudget: ${JSON.stringify(budget?.maxBudget)}`);
  console.log(`    budgetSummary.estimatedTotalCost: ${budget?.estimatedTotalCost}`);
  check('maxBudget 为 null（未设置）', budget?.maxBudget === null, `实际=${JSON.stringify(budget?.maxBudget)}`);
  check('estimatedTotalCost > 0（真实成本）', budget?.estimatedTotalCost > 0, `实际=${budget?.estimatedTotalCost}`);
  console.log('');

  console.log('【Bug2】按用品类型配置的 maxBudget 应该生效');
  await api('PUT', `/api/subscription/${uid}/config`, {
    enabled: true, cyclesAhead: 1,
    productStrategies: {
      sanitary_pad_regular: {
        maxBudget: 5,
        minSafetyStockDays: 3,
        skipRules: {}
      },
      tampon_regular: {
        maxBudget: null
      }
    }
  });
  r = await api('GET', `/api/subscription/${uid}/plan/preview`);
  const items = r.data?.plan?.cycles?.[0]?.items || [];
  const padItem = items.find(i => i.productId === 'sanitary_pad_regular');
  const tamponItem = items.find(i => i.productId === 'tampon_regular');
  console.log(`    sanitary_pad_regular:`);
  console.log(`      productMaxBudget 设置为: 5`);
  console.log(`      原始预算需求: ¥${padItem?.originalEstimatedCost ?? padItem?.estimatedCost}`);
  console.log(`      截断后 estimatedCost: ¥${padItem?.estimatedCost}`);
  console.log(`      productBudgetExceeded: ${padItem?.productBudgetExceeded}`);
  console.log(`      budgetTrimmed: ${padItem?.budgetTrimmed}`);
  console.log(`    tampon_regular (maxBudget=null):`);
  console.log(`      estimatedCost: ¥${tamponItem?.estimatedCost}`);
  console.log(`      productBudgetExceeded: ${tamponItem?.productBudgetExceeded}`);

  check('sanitary_pad_regular 被预算截断 (budgetTrimmed=true)', padItem?.budgetTrimmed === true);
  check('sanitary_pad_regular productBudgetExceeded=true', padItem?.productBudgetExceeded === true);
  check('sanitary_pad_regular estimatedCost <= 5', padItem?.estimatedCost <= 5, `实际=¥${padItem?.estimatedCost}`);
  check('sanitary_pad_regular 保存了原始成本', padItem?.originalEstimatedCost > padItem?.estimatedCost);
  check('tampon_regular 未设预算，不被截断', tamponItem?.budgetTrimmed !== true);
  check('tampon_regular estimatedCost > 0', tamponItem?.estimatedCost > 0);
  console.log('');

  console.log('【Bug3】skipWhenStockAboveDays 应按阈值判断，不应只要配置就跳过');
  await api('PUT', `/api/subscription/${uid}/config`, {
    enabled: true, cyclesAhead: 1,
    productStrategies: {
      sanitary_pad_regular: {
        minSafetyStockDays: 3,
        skipRules: { skipWhenStockAboveDays: 9999 }
      }
    }
  });
  r = await api('GET', `/api/subscription/${uid}/plan/preview`);
  let padLowThresh = r.data?.plan?.cycles?.[0]?.items?.find(i => i.productId === 'sanitary_pad_regular');
  console.log(`    skipWhenStockAboveDays=9999 时：`);
  console.log(`      skipped: ${padLowThresh?.skipped}, skipReason: ${padLowThresh?.skipReason ?? 'N/A'}`);
  console.log(`      stockDaysLeft: ${padLowThresh?.stockDaysLeft}`);
  check('阈值很大时不应跳过 (skipped=false 或 undefined)', !padLowThresh?.skipped, `实际=${padLowThresh?.skipped}`);

  await api('PUT', `/api/subscription/${uid}/config`, {
    enabled: true, cyclesAhead: 1,
    productStrategies: {
      sanitary_pad_regular: {
        minSafetyStockDays: 3,
        skipRules: { skipWhenStockAboveDays: 1 }
      }
    }
  });
  r = await api('GET', `/api/subscription/${uid}/plan/preview`);
  let padHighThresh = r.data?.plan?.cycles?.[0]?.items?.find(i => i.productId === 'sanitary_pad_regular');
  console.log(`    skipWhenStockAboveDays=1 时：`);
  console.log(`      skipped: ${padHighThresh?.skipped}, skipReason: ${padHighThresh?.skipReason ?? 'N/A'}`);
  console.log(`      stockDaysLeft: ${padHighThresh?.stockDaysLeft}`);
  check('阈值很小时库存超过则跳过 (skipped=true)', padHighThresh?.skipped === true, `实际=${padHighThresh?.skipped}`);
  check('跳过原因包含阈值说明', (padHighThresh?.skipReason || '').includes('超过配置的阈值'));

  console.log('');
  console.log('========== 专项验证完成 ==========');
}

test().catch(err => { console.error(err); process.exit(1); });
