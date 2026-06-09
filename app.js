const express = require('express');
const { success } = require('./utils/response');
const { replayAllEvents, persistSnapshot } = require('./models/store');

const inventoryRoutes = require('./routes/inventory');
const forecastRoutes = require('./routes/forecast');
const recommendationRoutes = require('./routes/recommendation');
const preferenceRoutes = require('./routes/preference');
const subscriptionRoutes = require('./routes/subscription');
const sharingRoutes = require('./routes/sharing');

console.log('\n[EventStore] 正在从事件日志回放恢复状态...');
replayAllEvents();
console.log('[EventStore] 状态恢复完成\n');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({
  verify: (req, res, buf, encoding) => {
    const str = buf.toString(encoding || 'utf8');
    if (!str || str.trim().length === 0) return;
    try {
      JSON.parse(str);
    } catch (e) {
      throw new SyntaxError('JSON 格式错误：' + e.message);
    }
  }
}));

app.use((req, res, next) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  next();
});

app.get('/', (req, res) => {
  success({
    name: '生理期用品库存监控与补货建议 API 服务',
    version: '3.0.0',
    features: {
      eventSourcing: '所有状态变更均记录为事件日志，支持服务重启后事件回放恢复',
      multiUserSubscription: '多用户长期订阅补货计划，支持 1-3 周期自动补货策略',
      planTraceability: '可追踪的补货计划快照，支持预览/确认/取消/版本对比/重算',
      sharedSpaceCollaboration: '家庭共享库存协作中心：支持多成员共同维护库存，聚合消费贡献、拆分预算责任、生成协作采购方案和代购结算账单，支持冲突检测和历史版本回滚'
    },
    endpoints: {
      'POST /api/inventory/report': '库存上报',
      'POST /api/subscription/inventory/backfill': '补录历史数据（不污染周期锚点）',
      'GET /api/inventory/history/:userId': '获取历史上报记录',
      'GET /api/inventory/products': '获取产品列表',
      'GET /api/forecast/:userId': '消耗预测',
      'GET /api/recommendation/:userId': '补货建议（支持 ?cycles=1|2|3）',
      'GET /api/preference/:userId': '偏好学习/异常检测',
      'PUT /api/preference/:userId': '更新用户偏好',
      'GET /api/subscription/:userId/config': '获取订阅补货配置',
      'PUT /api/subscription/:userId/config': '更新订阅补货配置（周期策略/预算/安全库存/跳过规则）',
      'GET /api/subscription/:userId/plan/preview': '预览补货计划',
      'POST /api/subscription/:userId/plan/recalculate': '重算/生成新补货计划',
      'GET /api/subscription/:userId/plans': '历史计划列表',
      'GET /api/subscription/:userId/plans/:planId': '计划详情',
      'GET /api/subscription/:userId/plans/compare?planIdA=&planIdB=': '计划版本对比',
      'POST /api/subscription/:userId/plans/:planId/confirm': '确认计划',
      'POST /api/subscription/:userId/plans/:planId/cancel': '取消计划',
      '--- 家庭共享库存协作 ---': '---',
      'POST /api/sharing/spaces': '创建共享空间',
      'PUT /api/sharing/spaces/:spaceId': '更新共享空间信息',
      'DELETE /api/sharing/spaces/:spaceId': '删除共享空间（owner）',
      'GET /api/sharing/spaces/:spaceId': '获取共享空间详情',
      'GET /api/sharing/spaces/user/:userId': '获取用户加入的所有共享空间',
      'POST /api/sharing/spaces/:spaceId/members/invite': '邀请成员加入',
      'POST /api/sharing/spaces/:spaceId/members/join': '成员加入空间',
      'POST /api/sharing/spaces/:spaceId/members/leave': '成员主动退出',
      'POST /api/sharing/spaces/:spaceId/members/remove': '管理员移除成员',
      'PUT /api/sharing/spaces/:spaceId/members': '更新成员角色/权重',
      'POST /api/sharing/spaces/:spaceId/records': '上报记录（consumption/purchase/borrow/return/preference）',
      'POST /api/sharing/spaces/:spaceId/records/backfill': '补录历史数据（不污染成员周期锚点）',
      'GET /api/sharing/spaces/:spaceId/inventory': '共享库存视图（按成员和产品聚合）',
      'GET /api/sharing/spaces/:spaceId/aggregation': '成员消费贡献聚合与预算责任拆分',
      'POST /api/sharing/spaces/:spaceId/plans/generate': '生成协作采购方案（谁该买、买多少、为谁买）',
      'POST /api/sharing/spaces/:spaceId/plans/:planId/confirm': '确认协作采购方案',
      'GET /api/sharing/spaces/:spaceId/plans': '采购方案历史列表',
      'POST /api/sharing/spaces/:spaceId/bills/generate': '生成代购结算账单',
      'GET /api/sharing/spaces/:spaceId/bills': '结算账单历史列表',
      'GET /api/sharing/spaces/:spaceId/conflicts': '查询操作冲突',
      'POST /api/sharing/spaces/:spaceId/conflicts/:conflictId/resolve': '解决操作冲突',
      'GET /api/sharing/spaces/:spaceId/versions': '历史版本快照列表',
      'GET /api/sharing/spaces/:spaceId/versions/rollback-preview': '回滚预览（对比差异）',
      'POST /api/sharing/spaces/:spaceId/versions/rollback': '执行版本回滚（事件日志回放）'
    }
  }, '服务运行中', res);
});

app.use('/api/inventory', inventoryRoutes);
app.use('/api/forecast', forecastRoutes);
app.use('/api/recommendation', recommendationRoutes);
app.use('/api/preference', preferenceRoutes);
app.use('/api/subscription', subscriptionRoutes);
app.use('/api/sharing', sharingRoutes);

app.use((req, res) => {
  res.status(404).json({
    code: 404,
    message: '接口不存在',
    data: { method: req.method, path: req.path }
  });
});

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  if (err instanceof SyntaxError || (err.type && err.type.includes('entity.parse.failed'))) {
    return res.status(400).json({
      code: 400,
      message: '请求体 JSON 格式错误，请检查参数格式',
      data: process.env.NODE_ENV === 'development' ? err.message : null
    });
  }
  res.status(500).json({
    code: 500,
    message: '服务器内部错误',
    data: process.env.NODE_ENV === 'development' ? err.message : null
  });
});

const server = app.listen(PORT, () => {
  console.log(`\n========================================`);
  console.log(`  生理期用品库存监控 API 服务已启动`);
  console.log(`  访问地址: http://localhost:${PORT}`);
  console.log(`========================================\n`);
});

function shutdown(signal) {
  console.log(`\n收到 ${signal} 信号，正在保存状态快照...`);
  try {
    persistSnapshot();
    console.log('状态快照保存完成，正在退出...');
  } catch (e) {
    console.error('保存快照失败:', e.message);
  }
  server.close(() => process.exit(0));
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
