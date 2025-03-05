// Variable declarations
const elliptic = window.elliptic;
const ec = new elliptic.ec('p256');
let keyPair = null;
let watchOnlyKey = null;
let ws = new WebSocket('ws://' + window.location.host);
let mining = false;
let currentPuzzle = null;
let worker = null;
let pendingAction = null;
let currentRoomId = 'general';
let lastMessageHash = '0000000000000000000000000000000000000000000000000000000000000000'; // Initial hash for the chain

// Add WebSocket onopen handler to request room list when connection is established
ws.onopen = () => {
    // Request room list when connection is established
    ws.send(JSON.stringify({
        type: 'getRoomList'
    }));
};

// Wrap DOM interactions in DOMContentLoaded
document.addEventListener('DOMContentLoaded', () => {
    // Add mining controls and public key display to HTML
    document.getElementById('keyControls').innerHTML += `
        <div id="miningControls" style="margin-top: 10px;">
            <button id="startMining" disabled>Start Mining</button>
            <button id="stopMining" disabled>Stop Mining</button>
            <span id="balance">Balance: 0 Hash</span>
            <div id="publicKeyDisplay" style="margin-top: 10px; word-break: break-all;"></div>
        </div>
    `;

    // Modal elements
    const modal = document.getElementById('signatureModal');
    const closeBtn = document.getElementsByClassName('close')[0];
    const confirmBtn = document.getElementById('confirmSignatureBtn');

    closeBtn.onclick = () => {
        modal.style.display = 'none';
        pendingAction = null;
    };

    window.onclick = (event) => {
        if (event.target == modal) {
            modal.style.display = 'none';
            pendingAction = null;
        }
    };

    confirmBtn.onclick = () => {
        const signature = document.getElementById('signatureInput').value;
        if (!signature) {
            alert('Please enter a signature');
            return;
        }

        if (pendingAction) {
            const { type, data } = pendingAction;
            if (type === 'message') {
                sendSignedMessage(data.message, signature, data.timestamp, data.prevHash);
            } else if (type === 'transfer') {
                sendSignedTransfer(data.recipientPublicKey, data.amount, signature, data.timestamp, data.prevHash);
            } else if (type === 'createRoom') {
                sendSignedCreateRoom(data.roomName, signature, data.timestamp, data.prevHash);
            } else if (type === 'roomTokenTransfer') {
                sendSignedRoomTokenTransfer(data.roomId, data.recipientPublicKey, data.amount, signature, data.timestamp, data.prevHash);
            }
        }

        modal.style.display = 'none';
        document.getElementById('signatureInput').value = '';
        pendingAction = null;
    };

    document.getElementById('startMining').onclick = () => {
        if (!keyPair && !watchOnlyKey) return;
        mining = true;
        document.getElementById('startMining').disabled = true;
        document.getElementById('stopMining').disabled = false;
        const publicKey = keyPair ? keyPair.getPublic('hex') : watchOnlyKey;
        mine(currentPuzzle, publicKey, 4);
    };

    document.getElementById('stopMining').onclick = () => {
        mining = false;
        document.getElementById('startMining').disabled = false;
        document.getElementById('stopMining').disabled = true;
    };

    document.getElementById('setKeyBtn').onclick = () => {
        const passphrase = document.getElementById('passphraseInput').value;
        if (!passphrase) {
            alert('Please enter a passphrase');
            return;
        }
        keyPair = deriveKeyFromPassphrase(passphrase);
        watchOnlyKey = null;
        document.getElementById('passphraseInput').value = '';
        updateUIState();
        requestBalance();

        // Request room list to refresh room token balances
        ws.send(JSON.stringify({
            type: 'getRoomList'
        }));

        console.log('Key set from passphrase');
    };

    document.getElementById('setWatchOnlyBtn').onclick = () => {
        const publicKeyHex = document.getElementById('watchOnlyInput').value;
        try {
            // Validate the public key
            ec.keyFromPublic(publicKeyHex, 'hex');
            watchOnlyKey = publicKeyHex;
            keyPair = null;
            document.getElementById('watchOnlyInput').value = '';
            updateUIState();
            requestBalance();

            // Request room list to refresh room token balances
            ws.send(JSON.stringify({
                type: 'getRoomList'
            }));

            console.log('Watch-only mode enabled');
        } catch (error) {
            alert('Invalid public key');
        }
    };

    document.getElementById('forgetKeyBtn').onclick = () => {
        keyPair = null;
        watchOnlyKey = null;
        updateUIState();
        resetBalance();

        // Request room list to refresh room token balances
        ws.send(JSON.stringify({
            type: 'getRoomList'
        }));

        console.log('Key forgotten');
    };

    document.getElementById('sendBtn').onclick = () => {
        const message = document.getElementById('messageInput').value;
        if (!message) return;

        const timestamp = Date.now().toString();
        if (keyPair) {
            const signature = keyPair.sign(message + timestamp + lastMessageHash).toDER('hex');
            sendSignedMessage(message, signature, timestamp, lastMessageHash);
        } else if (watchOnlyKey) {
            pendingAction = {
                type: 'message',
                data: { message, timestamp, prevHash: lastMessageHash }
            };
            document.getElementById('signatureMessage').textContent = message + timestamp + lastMessageHash;
            document.getElementById('signatureModal').style.display = 'block';
        }
    };

    document.getElementById('createRoomBtn').onclick = () => {
        const roomName = document.getElementById('newRoomInput').value;
        if (!roomName) {
            alert('Please enter a room name');
            return;
        }

        const timestamp = Date.now().toString();
        if (keyPair) {
            const signature = keyPair.sign(roomName + timestamp + lastMessageHash).toDER('hex');
            sendSignedCreateRoom(roomName, signature, timestamp, lastMessageHash);
        } else if (watchOnlyKey) {
            pendingAction = {
                type: 'createRoom',
                data: { roomName, timestamp, prevHash: lastMessageHash }
            };
            document.getElementById('signatureMessage').textContent = roomName + timestamp + lastMessageHash;
            document.getElementById('signatureModal').style.display = 'block';
        }

        document.getElementById('newRoomInput').value = '';
    };

    // Room token transfer
    const sendRoomTokenBtn = document.getElementById('sendRoomTokenBtn');
    sendRoomTokenBtn.onclick = () => {
        const recipientPublicKey = document.getElementById('tokenRecipient').value.trim();
        const amountStr = document.getElementById('tokenAmount').value.trim();

        if (!recipientPublicKey || !amountStr) {
            alert('Please enter recipient public key and amount');
            return;
        }

        const amount = parseInt(amountStr, 10);
        if (isNaN(amount) || amount <= 0) {
            alert('Please enter a valid amount');
            return;
        }

        const timestamp = Date.now();

        if (keyPair) {
            // If we have a key pair, sign the message automatically
            const messageToSign = currentRoomId + recipientPublicKey + amount + timestamp + lastMessageHash;
            const signature = keyPair.sign(messageToSign).toDER('hex');
            sendSignedRoomTokenTransfer(currentRoomId, recipientPublicKey, amount, signature, timestamp, lastMessageHash);

            // Clear input fields
            document.getElementById('tokenRecipient').value = '';
            document.getElementById('tokenAmount').value = '';
        } else if (watchOnlyKey) {
            // Only show the modal in watch-only mode
            const messageToSign = currentRoomId + recipientPublicKey + amount + timestamp + lastMessageHash;

            // Set up the pending action
            pendingAction = {
                type: 'roomTokenTransfer',
                data: {
                    roomId: currentRoomId,
                    recipientPublicKey: recipientPublicKey,
                    amount: amount,
                    timestamp: timestamp,
                    prevHash: lastMessageHash
                }
            };

            // Show the signature modal
            document.getElementById('signatureMessage').textContent = messageToSign;
            document.getElementById('signatureInput').value = '';
            document.getElementById('signatureModal').style.display = 'block';
        } else {
            alert('Please load or generate a key first');
        }
    };

    // Hash token transfer
    document.getElementById('transferBtn').onclick = () => {
        const recipientPublicKey = document.getElementById('recipientPublicKey').value;
        const amount = parseInt(document.getElementById('transferAmount').value, 10);

        if (!recipientPublicKey || isNaN(amount) || amount <= 0) {
            alert('Please enter a valid recipient and amount');
            return;
        }

        const timestamp = Date.now().toString();
        if (keyPair) {
            const signature = keyPair.sign(recipientPublicKey + amount + timestamp + lastMessageHash).toDER('hex');
            sendSignedTransfer(recipientPublicKey, amount, signature, timestamp, lastMessageHash);
        } else if (watchOnlyKey) {
            pendingAction = {
                type: 'transfer',
                data: {
                    recipientPublicKey: recipientPublicKey,
                    amount: amount,
                    timestamp: timestamp,
                    prevHash: lastMessageHash
                }
            };
            document.getElementById('signatureMessage').textContent = recipientPublicKey + amount + timestamp + lastMessageHash;
            document.getElementById('signatureModal').style.display = 'block';
        }
    };
});

function sendSignedMessage(message, signature, timestamp, prevHashOverride) {
    const publicKey = keyPair ? keyPair.getPublic('hex') : watchOnlyKey;
    const prevHash = prevHashOverride || lastMessageHash;

    ws.send(JSON.stringify({
        message,
        timestamp,
        signature,
        publicKey,
        prevHash
    }));

    document.getElementById('messageInput').value = '';
}

function sendSignedTransfer(recipientPublicKey, amount, signature, timestamp, prevHashOverride) {
    const publicKey = keyPair ? keyPair.getPublic('hex') : watchOnlyKey;
    const prevHash = prevHashOverride || lastMessageHash;

    ws.send(JSON.stringify({
        type: 'transfer',
        recipientPublicKey,
        amount,
        timestamp,
        signature,
        publicKey,
        prevHash
    }));

    document.getElementById('recipientPublicKey').value = '';
    document.getElementById('transferAmount').value = '';
}

function sendSignedCreateRoom(roomName, signature, timestamp, prevHashOverride) {
    const publicKey = keyPair ? keyPair.getPublic('hex') : watchOnlyKey;
    const prevHash = prevHashOverride || lastMessageHash;

    ws.send(JSON.stringify({
        type: 'createRoom',
        roomName,
        timestamp,
        signature,
        publicKey,
        prevHash
    }));
}

function sendSignedRoomTokenTransfer(roomId, recipientPublicKey, amount, signature, timestamp, prevHashOverride) {
    const publicKey = keyPair ? keyPair.getPublic('hex') : watchOnlyKey;
    const prevHash = prevHashOverride || lastMessageHash;

    ws.send(JSON.stringify({
        type: 'roomTokenTransfer',
        roomId,
        recipientPublicKey,
        amount,
        timestamp,
        signature,
        publicKey,
        prevHash
    }));

    document.getElementById('tokenRecipient').value = '';
    document.getElementById('tokenAmount').value = '';
}

function updateUIState() {
    const hasKey = keyPair !== null || watchOnlyKey !== null;
    const canSign = keyPair !== null;
    
    document.getElementById('messageInput').disabled = !hasKey;
    document.getElementById('sendBtn').disabled = !hasKey;
    document.getElementById('transferBtn').disabled = !hasKey;
    document.getElementById('createRoomBtn').disabled = !hasKey;
    document.getElementById('sendRoomTokenBtn').disabled = !hasKey;
    document.getElementById('startMining').disabled = !hasKey;
    document.getElementById('forgetKeyBtn').style.display = hasKey ? 'inline-block' : 'none';
    
    if (hasKey) {
        const publicKey = keyPair ? keyPair.getPublic('hex') : watchOnlyKey;
        document.getElementById('publicKeyDisplay').textContent = `Public Key: ${publicKey}`;
    } else {
        document.getElementById('publicKeyDisplay').textContent = '';
    }
}

function deriveKeyFromPassphrase(passphrase) {
    // Use SHA-256 to derive a deterministic private key from the passphrase
    const hash = CryptoJS.SHA256(passphrase).toString();
    // Use the first 32 bytes of the hash as the private key
    return ec.keyFromPrivate(hash.substring(0, 64), 'hex');
}

function requestBalance() {
    const publicKey = keyPair ? keyPair.getPublic('hex') : watchOnlyKey;
    if (publicKey) {
        ws.send(JSON.stringify({
            type: 'getBalance',
            publicKey
        }));
    }
}

function resetBalance() {
    document.getElementById('balance').textContent = 'Balance: 0 Hash';
}

function mine(puzzle, publicKey, difficulty) {
    if (!mining || !puzzle) return;
    
    // Try to find a valid nonce
    let nonce = Math.floor(Math.random() * 1000000000);
    const maxAttempts = 1000; // Limit attempts per batch to keep UI responsive
    
    for (let i = 0; i < maxAttempts && mining; i++) {
        // Check if this nonce works
        const hash = CryptoJS.SHA256(puzzle + publicKey + nonce).toString();
        const isValid = hash.substring(0, difficulty) === '0'.repeat(difficulty);
        
        if (isValid) {
            // Found a valid nonce, submit it
            ws.send(JSON.stringify({
                type: 'submitProofOfWork',
                puzzle,
                publicKey,
                nonce,
                difficulty
            }));
            
            // Wait for the next puzzle
            break;
        }
        
        nonce++;
    }
    
    // Schedule the next batch if still mining
    if (mining) {
        setTimeout(() => mine(puzzle, publicKey, difficulty), 0);
    }
}

// WebSocket message handler
ws.onmessage = (event) => {
    try {
        const data = JSON.parse(event.data);
        
        if (data.type === 'puzzle') {
            // Received a new mining puzzle
            currentPuzzle = data.puzzle;
            if (mining) {
                const publicKey = keyPair ? keyPair.getPublic('hex') : watchOnlyKey;
                mine(currentPuzzle, publicKey, data.difficulty);
            }
        } else if (data.type === 'balance') {
            // Update balance display
            document.getElementById('balance').textContent = `Balance: ${data.balance} Hash`;
        } else if (data.type === 'roomList') {
            // Update room list
            updateRoomList(data.rooms);
        } else if (data.type === 'joinRoom') {
            // Update current room display
            currentRoomId = data.roomId;
            document.getElementById('currentRoom').textContent = `Current Room: ${data.roomName}`;
            document.getElementById('messages').innerHTML = '';
            
            // Update last message hash
            if (data.lastMessageHash) {
                lastMessageHash = data.lastMessageHash;
            }
        } else if (data.type === 'message') {
            // Display message
            const msgData = data;
            const div = document.createElement('div');
            div.textContent = `${msgData.message} (from ${msgData.publicKey.slice(0,8)}...)`;
            document.getElementById('messages').appendChild(div);
            document.getElementById('messages').scrollTop = document.getElementById('messages').scrollHeight;
            
            // Update last message hash
            if (msgData.messageHash) {
                lastMessageHash = msgData.messageHash;
            }
        } else if (data.type === 'chatHistory') {
            // Display chat history
            document.getElementById('messages').innerHTML = '';
            data.messages.forEach(msg => {
                const div = document.createElement('div');
                div.textContent = `${data.message} (from ${data.publicKey.slice(0,8)}...)`;
                document.getElementById('messages').appendChild(div);
            });
            document.getElementById('messages').scrollTop = document.getElementById('messages').scrollHeight;
            
            // Update last message hash from the most recent message
            if (data.messages.length > 0 && data.messages[data.messages.length - 1].messageHash) {
                lastMessageHash = data.messages[data.messages.length - 1].messageHash;
            }
        }
    } catch (error) {
        console.error('Error handling WebSocket message:', error);
    }
};

function updateRoomList(rooms) {
    const roomList = document.getElementById('roomList');
    roomList.innerHTML = '';
    
    rooms.forEach(room => {
        const button = document.createElement('button');
        button.className = 'room-item';
        if (room.id === currentRoomId) {
            button.classList.add('active-room');
        }
        
        // Create room name element
        const nameSpan = document.createElement('span');
        nameSpan.textContent = room.name;
        button.appendChild(nameSpan);
        
        // Add creator info if available
        if (room.creator) {
            const creatorSpan = document.createElement('span');
            creatorSpan.className = 'room-creator';
            creatorSpan.textContent = ` (Created by: ${room.creator.slice(0, 8)}...)`;
            button.appendChild(creatorSpan);
        }
        
        // Add token balance if available
        if (room.tokenBalance !== undefined) {
            const balanceSpan = document.createElement('span');
            balanceSpan.className = 'room-token-balance';
            balanceSpan.textContent = ` Token Balance: ${room.tokenBalance}`;
            button.appendChild(balanceSpan);
        }
        
        button.onclick = () => {
            joinRoom(room.id);
        };
        
        roomList.appendChild(button);
    });
}

function joinRoom(roomId) {
    ws.send(JSON.stringify({
        type: 'joinRoom',
        roomId
    }));
} 