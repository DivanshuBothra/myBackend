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

async function getAddress(req, res, next) {
    try {
        const user = await userModel.findById(req.authUserId).select('username address');
        if (!user) {
            return res.status(401).json({ message: 'Please sign in to continue.' });
        }

        return res.status(200).json({
            profile: { id: user._id, username: user.username },
            address: user.address || null
        });
    } catch (error) {
        return next(error);
    }
}

async function updateAddress(req, res, next) {
    const body = req.body || {};
    const address = {
        fullName: typeof body.fullName === 'string' ? body.fullName.trim() : '',
        line1: typeof body.line1 === 'string' ? body.line1.trim() : '',
        line2: typeof body.line2 === 'string' ? body.line2.trim() : '',
        city: typeof body.city === 'string' ? body.city.trim() : '',
        state: typeof body.state === 'string' ? body.state.trim() : '',
        pincode: typeof body.pincode === 'string' ? body.pincode.trim() : ''
    };

    if (
        !address.fullName || address.fullName.length > 100 ||
        !address.line1 || address.line1.length > 150 ||
        address.line2.length > 150 ||
        !address.city || address.city.length > 80 ||
        !address.state || address.state.length > 80 ||
        !/^\d{6}$/.test(address.pincode)
    ) {
        return res.status(400).json({ message: 'Enter a full name, street address, city, state, and 6-digit PIN code.' });
    }

    try {
        const user = await userModel.findById(req.authUserId);
        if (!user) {
            return res.status(401).json({ message: 'Please sign in to continue.' });
        }

        user.address = address;
        await user.save();
        return res.status(200).json({
            message: 'Delivery address saved.',
            profile: { id: user._id, username: user.username },
            address: user.address
        });
    } catch (error) {
        return next(error);
    }
}

async function lookupAddressLocation(req, res) {
    const latitude = Number(req.body?.latitude);
    const longitude = Number(req.body?.longitude);
    const apiKey = process.env.GOOGLE_MAPS_API_KEY?.trim();

    if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 ||
        !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
        return res.status(400).json({ message: 'A valid device location is required.' });
    }
    if (!apiKey) {
        return res.status(503).json({ message: 'Google Maps location lookup is not configured on the server.' });
    }

    try {
        const url = new URL('https://maps.googleapis.com/maps/api/geocode/json');
        url.searchParams.set('latlng', `${latitude},${longitude}`);
        url.searchParams.set('key', apiKey);

        const response = await fetch(url);
        if (!response.ok) {
            return res.status(502).json({ message: 'Google Maps could not look up this location. Try again or enter it manually.' });
        }

        const result = await response.json();
        if (result.status !== 'OK' || !result.results?.length) {
            console.error('Google Maps reverse geocoding failed:', result.status);
            return res.status(result.status === 'ZERO_RESULTS' ? 404 : 503).json({
                message: result.status === 'ZERO_RESULTS'
                    ? 'No address was found for this location. Enter it manually.'
                    : 'Google Maps location lookup is unavailable. Try again or enter it manually.'
            });
        }

        const components = result.results[0].address_components || [];
        const getComponent = (...types) => {
            const component = components.find((item) => types.some((type) => item.types?.includes(type)));
            return component?.long_name || '';
        };
        const address = {
            city: getComponent('locality', 'postal_town', 'administrative_area_level_2', 'sublocality_level_1'),
            state: getComponent('administrative_area_level_1'),
            pincode: getComponent('postal_code')
        };

        return res.status(200).json(address);
    } catch (error) {
        console.error('Google Maps reverse geocoding request failed:', error.name);
        return res.status(502).json({ message: 'Google Maps could not look up this location. Try again or enter it manually.' });
    }
}

module.exports = {registerUser, loginUser, verifyCredentials, adminLoginUser, getAdminSession, logout, getAddress, updateAddress, lookupAddressLocation};
