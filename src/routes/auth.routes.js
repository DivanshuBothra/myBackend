const express = require('express');
const multer = require('multer');
const authController = require('../controllers/auth.controller');

const router = express.Router();
const parseFormFields = multer().none();

// Public registration always creates a regular user account.
router.post('/register', parseFormFields, authController.registerUser);
// Verify an account's credentials and issue its authentication cookie.
router.post('/login', parseFormFields, authController.loginUser);
// Admin direct login is available only to accounts with the stored admin role.
router.post('/admin-login', parseFormFields, authController.adminLoginUser);
router.get('/admin-session', authController.getAdminSession);

router.post("/logout", authController.logout)

module.exports = router;
