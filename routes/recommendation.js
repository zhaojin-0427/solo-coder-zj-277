const express = require('express');
const router = express.Router();
const { getRecommendation } = require('../controllers/recommendationController');

router.get('/:userId', getRecommendation);

module.exports = router;
