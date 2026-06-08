const express = require('express');
const router = express.Router();
const { getPreference, updatePreference } = require('../controllers/preferenceController');

router.get('/:userId', getPreference);
router.put('/:userId', updatePreference);

module.exports = router;
