const express = require('express'); const WebSocket = require('ws'); const
elliptic = require('elliptic'); const ec = new elliptic.ec('p256'); const
crypto = require('crypto'); const CryptoJS = require('crypto-js');

const app = express(); const server = require('http').createServer(app);
const wss = new WebSocket.Server({ server });

// Store chat history
const chatHistory = [];

// Add these constants at the top with other constants
const INITIAL_DIFFICULTY = 4; // Number of leading zeros required

// Track last message hash for each user to form a hash chain
const userLastMessageHash = new Map();

// Add room support
const rooms = new Map();
const roomTokens = new Map(); // Track token balances for each room
const INITIAL_TOKEN_SUPPLY = 1000000000; // 1 billion initial supply

// Set up general room with the specified creator
const generalRoomCreator = '0438e37b46e8e8756e3df4c3351e98e3f9638c424ed6c2eef39f74831b5eaeac5ada70b0d4f138a7eef6a4757bf8f2a732b76ccf7b17aeb6501908a21e40c2d605';
rooms.set('general', { name: 'General', messages: [], creator: generalRoomCreator });

// Initialize token balances for the general room
roomTokens.set('general', new Map());
roomTokens.get('general').set(generalRoomCreator, INITIAL_TOKEN_SUPPLY);

function calculateReward(difficulty) {
    // For n leading zeros, we need 16^n attempts on average (or 2^(4n))
    return Math.pow(16, difficulty);
}
let currentPuzzle = generateNewPuzzle();
const userBalances = new Map(); // Track balances per public key

app.use(express.static('public'));

function calculateMessageHash(message, publicKey, timestamp, prevHash) {
    return crypto.createHash('sha256')
        .update(message + publicKey + timestamp + prevHash)
        .digest('hex');
}

// Verify signatures on the server
function verifySignature(message, signature, publicKey) {
    try {
        // Check if signature is undefined or not a valid string
        if (!signature || typeof signature !== 'string') {
            console.error('Invalid signature format: signature is undefined or not a string');
            return false;
        }

        // Validate that the signature is a proper hex string
        if (!/^[0-9a-fA-F]+$/.test(signature)) {
            console.error('Invalid signature format: not a valid hex string');
            return false;
        }

        const key = ec.keyFromPublic(publicKey, 'hex');
        
        // The signature is already in DER hex format from the client
        return key.verify(message, signature);
    } catch (error) {
        console.error('Verification error:', error);
        return false;
    }
}

// Add these new functions before the WebSocket connection handler
function generateNewPuzzle() {
    return crypto.randomBytes(32).toString('hex');
}

function verifyProofOfWork(puzzle, publicKey, nonce, difficulty) {
    const data = puzzle + publicKey + nonce;
    const hash = crypto.createHash('sha256')
        .update(crypto.createHash('sha256').update(data).digest('hex'))
        .digest('hex');
    return hash.startsWith('0'.repeat(difficulty));
}

// Add this function to help with debugging
function logHashChainState(publicKey, action, prevHash, lastHash, messageHash) {
    console.log(`
    ===== HASH CHAIN STATE =====
    Action: ${action}
    Public Key: ${publicKey.substring(0, 16)}...
    Received prevHash: ${prevHash}
    Expected lastHash: ${lastHash}
    New messageHash: ${messageHash}
    Match: ${prevHash === lastHash ? 'YES' : 'NO'}
    ===========================
    `);
}

wss.on('connection', (ws) => {
    console.log('Client connected');

    // Set default room
    ws.currentRoom = 'general';

    // Send initial room list to the client
    ws.send(JSON.stringify({
        type: 'roomList',
        rooms: Array.from(rooms.keys()).map(id => ({
            id: id,
            name: rooms.get(id).name,
            creator: rooms.get(id).creator
        }))
    }));

    // Send current puzzle to the client
    ws.send(JSON.stringify({
        type: 'puzzle',
        puzzle: currentPuzzle
    }));

    ws.on('message', (data) => {
        try {
            const parsed = JSON.parse(data);

            // Handle proof-of-work solution
            if (parsed.type === 'solution') {
                const { nonce, publicKey } = parsed;
                if (verifyProofOfWork(currentPuzzle, publicKey, nonce, INITIAL_DIFFICULTY)) {
                    // Award balance
                    const currentBalance = userBalances.get(publicKey) || 0;
                    userBalances.set(publicKey, currentBalance + calculateReward(INITIAL_DIFFICULTY));

                    // Generate new puzzle and broadcast it
                    currentPuzzle = generateNewPuzzle();
                    wss.clients.forEach(client => {
                        if (client.readyState === WebSocket.OPEN) {
                            client.send(JSON.stringify({
                                type: 'puzzle',
                                puzzle: currentPuzzle,
                                difficulty: INITIAL_DIFFICULTY
                            }));
                        }
                    });

                    // Notify about balance
                    ws.send(JSON.stringify({
                        type: 'balance',
                        balance: userBalances.get(publicKey)
                    }));
                }
                return;
            }

            // Handle balance request
            if (parsed.type === 'getBalance') {
                const { publicKey } = parsed;
                const balance = userBalances.get(publicKey) || 0;
                ws.send(JSON.stringify({
                    type: 'balance',
                    balance: balance,
                    publicKey: publicKey
                }));
                return;
            }

            // Handle transfer request
            if (parsed.type === 'transfer') {
                const { recipientPublicKey, amount, timestamp, signature, publicKey, prevHash } = parsed;

                // Get the last message hash for this user, or use initial hash if none exists
                const lastHash = userLastMessageHash.get(publicKey) || '0000000000000000000000000000000000000000000000000000000000000000';

                // Ensure all values are properly converted to strings for verification
                // The order must match the client-side order in the signData function
                const messageToVerify = [
                    recipientPublicKey,
                    amount,
                    timestamp,
                    prevHash
                ].map(String).join('');
                
                console.log('Verifying transfer signature with message:', messageToVerify);
                console.log('Signature:', signature);
                console.log('Public key:', publicKey);

                // Verify the transfer request
                if (!verifySignature(messageToVerify, signature, publicKey)) {
                    console.log('Invalid transfer signature rejected');
                    return;
                }

                // Verify the previous hash matches what we have stored
                if (prevHash !== lastHash) {
                    console.log('Invalid transfer chain: previous hash mismatch');
                    console.log('Expected:', lastHash);
                    console.log('Received:', prevHash);
                    return;
                }

                const senderBalance = userBalances.get(publicKey) || 0;
                if (senderBalance < amount) {
                    console.log('Insufficient balance for transfer');
                    return;
                }

                // Calculate the hash of this transfer for the chain
                const transferHash = calculateMessageHash('transfer:' + recipientPublicKey + amount, publicKey, timestamp, prevHash);
                
                // Log hash chain state
                logHashChainState(publicKey, 'transfer', prevHash, lastHash, transferHash);

                // Update the last message hash for this user
                userLastMessageHash.set(publicKey, transferHash);

                // Deduct from sender's balance
                userBalances.set(publicKey, senderBalance - amount);

                // Add to recipient's balance
                const recipientBalance = userBalances.get(recipientPublicKey) || 0;
                userBalances.set(recipientPublicKey, recipientBalance + amount);

                // Notify both parties about the transfer
                ws.send(JSON.stringify({
                    type: 'balance',
                    balance: userBalances.get(publicKey),
                    messageHash: transferHash
                }));

                wss.clients.forEach(client => {
                    if (client.readyState === WebSocket.OPEN && client !== ws) {
                        client.send(JSON.stringify({
                            type: 'balance',
                            balance: userBalances.get(recipientPublicKey),
                            publicKey: recipientPublicKey
                        }));
                    }
                });

                return;
            }

            // Handle create room
            if (parsed.type === 'createRoom') {
                const { roomName, timestamp, signature, publicKey, prevHash } = parsed;

                // Get the last message hash for this user, or use initial hash if none exists
                const lastHash = userLastMessageHash.get(publicKey) || '0000000000000000000000000000000000000000000000000000000000000000';

                // Ensure all values are properly converted to strings for verification
                // The order must match the client-side order in the signData function
                const messageToVerify = [
                    roomName,
                    timestamp,
                    prevHash
                ].map(String).join('');
                
                console.log('Verifying create room signature with message:', messageToVerify);
                console.log('Signature:', signature);
                console.log('Public key:', publicKey);

                // Verify the create room request
                if (!verifySignature(messageToVerify, signature, publicKey)) {
                    console.log('Invalid create room signature rejected');
                    return;
                }

                // Verify the previous hash matches what we have stored
                if (prevHash !== lastHash) {
                    console.log('Invalid create room chain: previous hash mismatch');
                    console.log('Expected:', lastHash);
                    console.log('Received:', prevHash);
                    return;
                }

                // Calculate the hash of this room creation for the chain
                const roomCreationHash = calculateMessageHash('createRoom:' + roomName, publicKey, timestamp, prevHash);
                
                // Log hash chain state
                logHashChainState(publicKey, 'createRoom', prevHash, lastHash, roomCreationHash);

                // Update the last message hash for this user
                userLastMessageHash.set(publicKey, roomCreationHash);

                const roomId = 'room_' + Date.now();
                rooms.set(roomId, { name: roomName, messages: [], creator: publicKey });

                // Initialize token balances for the new room
                roomTokens.set(roomId, new Map());
                roomTokens.get(roomId).set(publicKey, INITIAL_TOKEN_SUPPLY);

                // Broadcast room list update to all clients
                wss.clients.forEach(client => {
                    if (client.readyState === WebSocket.OPEN) {
                        client.send(JSON.stringify({
                            type: 'roomList',
                            rooms: Array.from(rooms.keys()).map(id => ({
                                id: id,
                                name: rooms.get(id).name,
                                creator: rooms.get(id).creator
                            })),
                            messageHash: client === ws ? roomCreationHash : undefined
                        }));
                    }
                });

                return;
            }

            // Handle room joining
            if (parsed.type === 'joinRoom') {
                const { roomId } = parsed;

                if (!rooms.has(roomId)) {
                    console.log('Room not found');
                    return;
                }

                ws.currentRoom = roomId;

                // Send room history to the client
                ws.send(JSON.stringify({
                    type: 'roomHistory',
                    messages: rooms.get(roomId).messages
                }));

                return;
            }

            // Handle room list request
            if (parsed.type === 'getRoomList') {
                const requestingPublicKey = parsed.publicKey;
                
                // Send room list to the client
                ws.send(JSON.stringify({
                    type: 'roomList',
                    rooms: Array.from(rooms.keys()).map(id => {
                        // Get token balance for this user in this room if available
                        let tokenBalance = 0;
                        if (roomTokens.has(id) && requestingPublicKey) {
                            tokenBalance = roomTokens.get(id).get(requestingPublicKey) || 0;
                        }
                        
                        return {
                            id: id,
                            name: rooms.get(id).name,
                            creator: rooms.get(id).creator,
                            tokenBalance: tokenBalance
                        };
                    })
                }));

                return;
            }

            // Handle room token transfer
            if (parsed.type === 'roomTokenTransfer') {
                const { roomId, recipientPublicKey, amount, timestamp, signature, publicKey, prevHash } = parsed;

                // Validate the room exists
                if (!rooms.has(roomId)) {
                    console.log('Room not found for token transfer');
                    return;
                }

                // Get the last message hash for this user, or use initial hash if none exists
                const lastHash = userLastMessageHash.get(publicKey) || '0000000000000000000000000000000000000000000000000000000000000000';

                // Ensure all values are properly converted to strings for verification
                // The order must match the client-side order in the signData function
                const messageToVerify = [
                    roomId,
                    recipientPublicKey,
                    amount,
                    timestamp,
                    prevHash
                ].map(String).join('');
                
                console.log('Verifying room token transfer signature with message:', messageToVerify);
                console.log('Signature:', signature);
                console.log('Public key:', publicKey);

                // Verify the transfer request
                if (!verifySignature(messageToVerify, signature, publicKey)) {
                    console.log('Invalid room token transfer signature rejected');
                    return;
                }

                // Verify the previous hash matches what we have stored
                if (prevHash !== lastHash) {
                    console.log('Invalid room token transfer chain: previous hash mismatch');
                    console.log('Expected:', lastHash);
                    console.log('Received:', prevHash);
                    return;
                }

                // Get room token balances
                const roomTokenBalances = roomTokens.get(roomId);
                if (!roomTokenBalances) {
                    console.log('Room token balances not found');
                    return;
                }

                // Check sender's balance
                const senderBalance = roomTokenBalances.get(publicKey) || 0;
                if (senderBalance < amount) {
                    console.log('Insufficient room token balance for transfer');
                    return;
                }

                // Calculate the hash of this transfer for the chain
                const transferHash = calculateMessageHash('roomTokenTransfer:' + roomId + recipientPublicKey + amount, publicKey, timestamp, prevHash);
                
                // Log hash chain state
                logHashChainState(publicKey, 'roomTokenTransfer', prevHash, lastHash, transferHash);

                // Update the last message hash for this user
                userLastMessageHash.set(publicKey, transferHash);

                // Deduct from sender's balance
                roomTokenBalances.set(publicKey, senderBalance - amount);

                // Add to recipient's balance
                const recipientBalance = roomTokenBalances.get(recipientPublicKey) || 0;
                roomTokenBalances.set(recipientPublicKey, recipientBalance + amount);

                // Notify both parties about the transfer
                ws.send(JSON.stringify({
                    type: 'roomTokenBalance',
                    roomId: roomId,
                    balance: roomTokenBalances.get(publicKey),
                    messageHash: transferHash
                }));

                // Notify recipient if they're connected
                wss.clients.forEach(client => {
                    if (client.readyState === WebSocket.OPEN && client !== ws) {
                        client.send(JSON.stringify({
                            type: 'roomTokenBalance',
                            roomId: roomId,
                            balance: roomTokenBalances.get(recipientPublicKey),
                            publicKey: recipientPublicKey,
                            // Don't include messageHash for recipient as it would overwrite their own chain
                        }));
                    }
                });

                return;
            }

            // Handle room token balance request
            if (parsed.type === 'getRoomTokenBalance') {
                const { roomId, publicKey } = parsed;

                if (!rooms.has(roomId) || !roomTokens.has(roomId)) {
                    console.log('Room not found for token balance request');
                    return;
                }

                const roomTokenBalances = roomTokens.get(roomId);
                const balance = roomTokenBalances.get(publicKey) || 0;
                
                // Get the last message hash for this user
                const lastHash = userLastMessageHash.get(publicKey) || '0000000000000000000000000000000000000000000000000000000000000000';

                ws.send(JSON.stringify({
                    type: 'roomTokenBalance',
                    roomId: roomId,
                    balance: balance,
                    publicKey: publicKey,
                    messageHash: lastHash
                }));

                return;
            }

            // Handle chat message
            if (parsed.type === 'message') {
                const { message, signature, publicKey, timestamp, prevHash } = parsed;
                
                // Get the last message hash for this user, or use initial hash if none exists
                const lastHash = userLastMessageHash.get(publicKey) || '0000000000000000000000000000000000000000000000000000000000000000';
                
                // Ensure all values are properly converted to strings for verification
                // The order must match the client-side order in the signData function
                const messageToVerify = [
                    message,
                    timestamp,
                    prevHash
                ].map(String).join('');
                
                console.log('Verifying message signature with message:', messageToVerify);
                console.log('Signature:', signature);
                console.log('Public key:', publicKey);
                
                // Verify the message signature
                if (!verifySignature(messageToVerify, signature, publicKey)) {
                    console.log('Invalid message signature rejected');
                    return;
                }
                
                // Verify the previous hash matches what we have stored
                if (prevHash !== lastHash) {
                    console.log('Invalid message chain: previous hash mismatch');
                    console.log('Expected:', lastHash);
                    console.log('Received:', prevHash);
                    return;
                }
                
                // Calculate the hash of this message for the chain
                const messageHash = calculateMessageHash(message, publicKey, timestamp, prevHash);
                
                // Log hash chain state
                logHashChainState(publicKey, 'message', prevHash, lastHash, messageHash);
                
                // Update the last message hash for this user
                userLastMessageHash.set(publicKey, messageHash);
                
                // Store the message in the current room
                const roomId = ws.currentRoom || 'general';
                if (rooms.has(roomId)) {
                    rooms.get(roomId).messages.push({
                        message,
                        publicKey,
                        timestamp,
                        messageHash
                    });
                }

                // Broadcast valid messages to all clients in the same room
                wss.clients.forEach(client => {
                    if (client.readyState === WebSocket.OPEN && client.currentRoom === ws.currentRoom) {
                        client.send(JSON.stringify({
                            message,
                            publicKey,
                            roomId: ws.currentRoom,
                            messageHash
                        }));
                    }
                });
            }

            // Handle last message hash request
            if (parsed.type === 'getLastMessageHash') {
                const { publicKey } = parsed;
                
                // Get the last message hash for this user, or use initial hash if none exists
                const lastHash = userLastMessageHash.get(publicKey) || '0000000000000000000000000000000000000000000000000000000000000000';
                
                console.log('Sending last message hash for', publicKey, ':', lastHash);
                
                // Send the last message hash to the client
                ws.send(JSON.stringify({
                    type: 'lastMessageHash',
                    publicKey: publicKey,
                    lastMessageHash: lastHash
                }));
                
                return;
            }
        } catch (error) {
            console.error('Error processing message:', error);
        }
    });
});

// Create public directory and write index.html
const fs = require('fs');
if (!fs.existsSync('./public')) {
    fs.mkdirSync('./public');
}

server.listen(3000, () => {
    console.log('Server running on http://localhost:3000');
});
