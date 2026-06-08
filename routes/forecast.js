const express = require('express');
const router = express.Router();
const { getForecast } = require('../controllers/forecastController');

router.get('/:userId', getForecast);

module.exports = router;
