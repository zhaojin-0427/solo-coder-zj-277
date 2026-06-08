const express = require('express');
const { success } = require('./utils/response');

const inventoryRoutes = require('./routes/inventory');
const forecastRoutes = require('./routes/forecast');
const recommendationRoutes = require('./routes/recommendation');
const preferenceRoutes = require('./routes/preference');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({
  verify: (req, res, buf, encoding) => {
    try {
      JSON.parse(buf.toString(encoding || 'utf8'));
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
    version: '1.0.0',
    endpoints: {
      'POST /api/inventory/report': '库存上报',
      'GET /api/inventory/history/:userId': '获取历史上报记录',
      'GET /api/inventory/products': '获取产品列表',
      'GET /api/forecast/:userId': '消耗预测',
      'GET /api/recommendation/:userId': '补货建议（支持 ?cycles=1|2|3）',
      'GET /api/preference/:userId': '偏好学习/异常检测',
      'PUT /api/preference/:userId': '更新用户偏好'
    }
  }, '服务运行中', res);
});

app.use('/api/inventory', inventoryRoutes);
app.use('/api/forecast', forecastRoutes);
app.use('/api/recommendation', recommendationRoutes);
app.use('/api/preference', preferenceRoutes);

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

app.listen(PORT, () => {
  console.log(`\n========================================`);
  console.log(`  生理期用品库存监控 API 服务已启动`);
  console.log(`  访问地址: http://localhost:${PORT}`);
  console.log(`========================================\n`);
});
