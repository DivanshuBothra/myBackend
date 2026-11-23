const crypto = require('crypto');
const mongoose = require('mongoose');
const { ImageKit, toFile } = require('@imagekit/nodejs');

// Image bytes live in ImageKit; MongoDB stores only the resulting public URL.
const imagekit = new ImageKit({
    privateKey: process.env.IMAGEKIT_PRIVATE_KEY
});

// GridFS is read-only here so products created before the ImageKit switch keep working.
let bucket;
let bucketDatabase;

// Reuse a GridFS bucket to serve legacy product images.
function getImageBucket() {
    const database = mongoose.connection.db;
    if (!database) {
        throw new Error('MongoDB is not connected');
    }

    if (database !== bucketDatabase) {
        bucketDatabase = database;
        bucket = new mongoose.mongo.GridFSBucket(database, {
            bucketName: 'productImages'
        });
    }

    return bucket;
}

// Reject malformed IDs before asking MongoDB for a legacy image.
function toObjectId(fileId) {
    if (!mongoose.Types.ObjectId.isValid(fileId)) {
        return null;
    }

    return new mongoose.Types.ObjectId(fileId);
}

// Upload a product image to ImageKit and return its ID for cleanup and its URL for Product.
async function uploadImage(buffer, originalName, contentType) {
    const safeName = (originalName || 'image').replace(/[^a-zA-Z0-9._-]/g, '_');
    const fileName = `${crypto.randomUUID()}-${safeName}`;

    const result = await imagekit.files.upload({
        file: await toFile(buffer, fileName, { type: contentType }),
        fileName,
        folder: 'product_images'
    });

    if (!result.fileId || !result.url) {
        throw new Error('ImageKit upload did not return a file ID and URL');
    }

    return { id: result.fileId, url: result.url };
}

function getUploadAuthenticationParameters() {
    return imagekit.helper.getAuthenticationParameters();
}

// Find an image that was stored in GridFS before new uploads moved to ImageKit.
async function findImage(fileId) {
    const id = toObjectId(fileId);
    if (!id) {
        return null;
    }

    const [file] = await getImageBucket().find({ _id: id }).limit(1).toArray();
    return file || null;
}

// Stream a legacy GridFS image to the existing image endpoint.
function downloadImage(fileId) {
    const id = toObjectId(fileId);
    if (!id) {
        return null;
    }

    return getImageBucket().openDownloadStream(id);
}

// Remove a newly uploaded ImageKit image if saving its Product document fails.
async function deleteImage(fileId) {
    await imagekit.files.delete(fileId);
}

module.exports = {
    uploadImage,
    getUploadAuthenticationParameters,
    findImage,
    downloadImage,
    deleteImage
};
