const userModel = require('../models/user.model');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

// Register a regular user; account roles are assigned by the server, not by request data.
async function registerUser(req, res) {
    const { username, phonenum, password, role } = req.body;
    console.log(reg.body)
    const existingUser = await userModel.findOne({
        phonenum
    });

    if (existingUser) {
        return res.status(400).json({ message: 'User already exists' });
    }

    const hash = await bcrypt.hash(password, 10);

    const user = await userModel.create({
        username,
        phonenum,
        password: hash,
        role
    });

    // The User schema defaults new accounts to "user", so clients cannot self-assign admin.
    const token = jwt.sign({
        id: user._id,
        phonenum: user.phonenum,
        role: user.role,
    }, process.env.JWT_SECRET);

    res.cookie('token', token);

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
    const { phonenum, password } = req.body;

    const user = await userModel.findOne({ phonenum });
    if (!user) {
        return res.status(401).json({ message: 'Invalid credentials' });
    }

    const isPasswordValid = await bcrypt.compare(password, user.password);

    if (!isPasswordValid) {
        return res.status(400).json({ message: 'Invalid credentials' });
    }

    const token = jwt.sign({
        id: user._id,
        phonenum: user.phonenum,
        role: user.role,
    }, process.env.JWT_SECRET);

    res.cookie('token', token);

    res.status(200).json({
        message: 'User logged in successfully',
        user: {
            id: user._id,
            username: user.username,
            phonenum: user.phonenum,
            role: user.role
        }
    });
}

//logout
async function logout(req, res) {
    res.clearCookie("token")
    res.status(200).json({message: "User logout successfully"})
}

module.exports = {registerUser, loginUser, logout};