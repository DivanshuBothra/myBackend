const express = require('express');
const authController = require('../controllers/auth.controller');

const router = express.Router();

// Register an account; new registrations receive the regular-user role.
router.post('/register', authController.registerUser);
// Verify an account's credentials and issue its authentication cookie.
router.post('/login', authController.loginUser);

router.post("/logout", authController.logout)

module.exports = router;