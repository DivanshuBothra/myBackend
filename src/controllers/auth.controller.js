const userModel = require('../models/user.model');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const TEST_LOGIN_OTP = '123456';

const cookieOptions = {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
    path: '/'
};

function issueAuthCookie(user, res) {
    const token = jwt.sign({
        id: user._id,
        phonenum: user.phonenum,
        role: user.role,
    }, process.env.JWT_SECRET);

    res.cookie('token', token, {
        httpOnly: true,
        secure: true,
        sameSite: 'none',
        maxAge: 7 * 24 * 60 * 60 * 1000
    });
}

function toPublicUser(user) {
    return {
        id: user._id,
        username: user.username,
        phonenum: user.phonenum,
        role: user.role
    };
}

async function findUserWithValidCredentials(phonenum, password) {
    if (typeof phonenum !== 'string' || typeof password !== 'string') {
        return null;
    }

    const user = await userModel.findOne({ phonenum });
    if (!user || !(await bcrypt.compare(password, user.password))) {
        return null;
    }

    return user;
}

// Register a regular user; account roles are assigned by the server, not by request data.
async function registerUser(req, res) {
// Only take these three fields from the client. Role is never read from the request.
const { username, phonenum, password } = req.body || {};
const normalizedUsername = typeof username === 'string' ? username.trim() : '';

if (!normalizedUsername) {
return res.status(400).json({ message: 'Username is required.' });
}
if (normalizedUsername.length > 16) {
return res.status(400).json({ message: 'Username must be 16 characters or fewer.' });
}
if (typeof password !== 'string' || password.length < 8 || password.length > 16) {
return res.status(400).json({ message: 'Password must be between 8 and 16 characters.' });
}

const existingUser = await userModel.findOne({ phonenum });
if (existingUser) {
return res.status(400).json({ message: 'User already exists' });
}

const hash = await bcrypt.hash(password, 10);

// Role is always set by the server, so nobody can register as admin.
const user = await userModel.create({
username: normalizedUsername,
phonenum,
password: hash,
role: 'user'
});

const token = jwt.sign(
{ id: user._id, phonenum: user.phonenum, role: user.role },
process.env.JWT_SECRET
);

res.cookie('token', token, {
httpOnly: true,
secure: true,
sameSite: 'none',
maxAge: 7 * 24 * 60 * 60 * 1000
});

res.status(201).json({
message: 'User registered successfully',
user: {
id: user._id,
username: user.username,
phonenum: user.phonenum,
role: user.role
}
});
}

// Verify credentials, then issue a cookie containing the account's stored role.
async function loginUser(req, res) {
    const { phonenum, password, otp } = req.body || {};
    const user = await findUserWithValidCredentials(phonenum, password);
    if (!user) {
        return res.status(401).json({ message: 'Invalid credentials' });
    }

    if (process.env.NODE_ENV === 'production') {
        return res.status(503).json({ message: 'SMS OTP is not configured. Please try again later.' });
    }

    if (otp !== TEST_LOGIN_OTP) {
        return res.status(401).json({ message: 'Wrong OTP. Please try again.' });
    }

    issueAuthCookie(user, res);

    res.status(200).json({
        message: 'User logged in successfully',
        user: toPublicUser(user)
    });
}

async function verifyCredentials(req, res) {
    const { phonenum, password } = req.body || {};
    const user = await findUserWithValidCredentials(phonenum, password);
    if (!user) {
        return res.status(401).json({ message: 'Phone number or password is incorrect.' });
    }

    if (process.env.NODE_ENV === 'production') {
        return res.status(503).json({ message: 'SMS OTP is not configured. Please try again later.' });
    }

    return res.status(200).json({ message: 'Credentials verified.' });
}

async function adminLoginUser(req, res) {
    const { phonenum, password } = req.body || {};
    const user = await findUserWithValidCredentials(phonenum, password);
    if (!user || user.role !== 'admin') {
        return res.status(401).json({ message: 'Invalid credentials' });
    }

    issueAuthCookie(user, res);
    return res.status(200).json({
        message: 'Admin logged in successfully',
        user: toPublicUser(user)
    });
}

async function getAdminSession(req, res) {
    const token = req.cookies?.token;
    if (!token) {
        return res.status(401).json({ message: 'Unauthorized' });
    }

    let decoded;
    try {
        decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch {
        return res.status(401).json({ message: 'Unauthorized' });
    }

    if (decoded.role !== 'admin') {
        return res.status(403).json({ message: 'Admin access required' });
    }

    const user = await userModel.findById(decoded.id);
    if (!user || user.role !== 'admin') {
        return res.status(403).json({ message: 'Admin access required' });
    }

    return res.status(200).json({ user: toPublicUser(user) });
}

//logout
async function logout(req, res) {
    res.clearCookie('token', cookieOptions);
    res.status(200).json({message: "User logout successfully"})
}

module.exports = {registerUser, loginUser, verifyCredentials, adminLoginUser, getAdminSession, logout};
