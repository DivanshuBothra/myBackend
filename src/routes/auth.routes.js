const express = require('express');
const multer = require('multer');
const authController = require('../controllers/auth.controller');

const router = express.Router();
const parseFormFields = multer().none();

// Register an account; new registrations receive the regular-user role.
router.post('/register', parseFormFields, authController.registerUser);
// Verify an account's credentials and issue its authentication cookie.
router.post('/login', parseFormFields, authController.loginUser);

router.post("/logout", authController.logout)

module.exports = router;
