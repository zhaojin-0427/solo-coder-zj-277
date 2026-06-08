const express = require('express');
const router = express.Router();
const { reportInventory, getInventoryHistory } = require('../controllers/inventoryController');
const { success } = require('../utils/response');
const { getAllProducts } = require('../models/store');

router.post('/report', reportInventory);
router.get('/history/:userId', getInventoryHistory);

router.get('/products', (req, res) => {
  res.json(success({
    products: getAllProducts(),
    cyclePhases: ['menstrual', 'follicular', 'ovulation', 'luteal']
  }, '产品列表获取成功'));
});

module.exports = router;
