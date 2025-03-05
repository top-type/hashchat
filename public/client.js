// Variable declarations
const elliptic = window.elliptic;
const ec = new elliptic.ec('p256');
let keyPair = null;
let watchOnlyKey = null;
let ws = new WebSocket('ws://' + window.location.host);
let mining = false;
let currentPuzzle = null;
let currentDifficulty = 4; // Default difficulty level
let worker = null;
let pendingAction = null;
let currentRoomId = 'general';
let lastMessageHash = '0000000000000000000000000000000000000000000000000000000000000000'; // Initial hash for the chain

// Add WebSocket onopen handler to request room list when connection is established
ws.onopen = () => {
    console.log('WebSocket connection established');
    // Request room list when connection is established
    ws.send(JSON.stringify({
        type: 'getRoomList',
        publicKey: watchOnlyKey || (keyPair ? keyPair.getPublic('hex') : null)
    }));
};

// Add WebSocket error and close handlers for better debugging
ws.onerror = (error) => {
    console.error('WebSocket error:', error);
};

ws.onclose = (event) => {
    console.log('WebSocket connection closed:', event.code, event.reason);
};

// Wrap DOM interactions in DOMContentLoaded
document.addEventListener('DOMContentLoaded', () => {
    // Add mining controls and public key display to HTML
    document.getElementById('keyControls').innerHTML += `
        <div id="miningControls" style="margin-top: 10px;">
            <button id="startMining" disabled>Start Mining</button>
            <button id="stopMining" disabled>Stop Mining</button>
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
        const signature = document.getElementById('signatureInput').value.trim();
        if (!signature) {
            alert('Please enter a signature');
            return;
        }

        // Validate that the signature is a proper hex string
        if (!/^[0-9a-fA-F]+$/.test(signature)) {
            alert('Invalid signature format. Please enter a valid DER hex format signature.');
            return;
        }

        if (pendingAction) {
            const { type, data } = pendingAction;
            console.log('Processing pending action:', type, 'with data:', data);
            
            if (type === 'message') {
                sendSignedMessage(data.message, signature, data.timestamp, data.prevHash);
            } else if (type === 'transfer') {
                // Parse amount as integer
                const amount = parseInt(data.amount, 10);
                sendSignedTransfer(data.recipientPublicKey, amount, signature, data.timestamp, data.prevHash);
            } else if (type === 'createRoom') {
                sendSignedCreateRoom(data.roomName, signature, data.timestamp, data.prevHash);
            } else if (type === 'roomTokenTransfer') {
                // Parse amount as integer
                const amount = parseInt(data.amount, 10);
                sendSignedRoomTokenTransfer(data.roomId, data.recipientPublicKey, amount, signature, data.timestamp, data.prevHash);
            }
        }

        modal.style.display = 'none';
        document.getElementById('signatureInput').value = '';
        pendingAction = null;
    };

    // Add a helper function to show signature format example
    function showSignatureExample() {
        // Create a temporary key pair just for the example
        const tempKeyPair = ec.genKeyPair();
        const exampleMessage = "example";
        const exampleSignature = tempKeyPair.sign(exampleMessage).toDER('hex');
        
        return `Example DER hex format signature: ${exampleSignature}`;
    }

    // Update the modal display to show an example signature
    const originalShowModal = document.getElementById('signatureModal').style.display;
    Object.defineProperty(document.getElementById('signatureModal').style, 'display', {
        set: function(value) {
            if (value === 'block') {
                // Add example signature help text when modal is shown
                const helpText = document.createElement('p');
                helpText.className = 'signature-help';
                helpText.textContent = showSignatureExample();
                
                // Remove any existing help text
                const existingHelp = document.querySelector('.signature-help');
                if (existingHelp) existingHelp.remove();
                
                // Add the new help text
                document.querySelector('.modal-content').appendChild(helpText);
            }
            this.cssText = `display: ${value}`;
        },
        get: function() {
            return this.cssText.replace('display: ', '');
        }
    });

    document.getElementById('startMining').onclick = () => {
        if (!keyPair && !watchOnlyKey) return;
        mining = true;
        document.getElementById('startMining').disabled = true;
        document.getElementById('stopMining').disabled = false;
        const publicKey = keyPair ? keyPair.getPublic('hex') : watchOnlyKey;
        mine(currentPuzzle, publicKey, currentDifficulty);
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
            type: 'getRoomList',
            publicKey: keyPair ? keyPair.getPublic('hex') : null
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
                type: 'getRoomList',
                publicKey: watchOnlyKey
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
            type: 'getRoomList',
            publicKey: null
        }));

        console.log('Key forgotten');
    };

    document.getElementById('sendBtn').onclick = () => {
        const message = document.getElementById('messageInput').value.trim();
        if (!message) return;

        const timestamp = Date.now().toString();
        
        if (keyPair) {
            // Create signature with consistent format
            const dataToSign = {
                message,
                timestamp,
                prevHash: lastMessageHash
            };
            
            const signature = signData(dataToSign);
            console.log('Generated signature for message:', signature);
            sendSignedMessage(message, signature, timestamp, lastMessageHash);
        } else if (watchOnlyKey) {
            const pendingData = {
                type: 'message',
                data: {
                    message,
                    timestamp,
                    prevHash: lastMessageHash
                }
            };
            
            pendingAction = pendingData;
            
            // Show the signature modal with consistently formatted message
            document.getElementById('signatureMessage').textContent = prepareSignatureMessage(pendingData.data);
            document.getElementById('signatureModal').style.display = 'block';
        }
    };

    document.getElementById('createRoomBtn').onclick = () => {
        const roomName = document.getElementById('newRoomInput').value.trim();
        if (!roomName) {
            alert('Please enter a room name');
            return;
        }

        const timestamp = Date.now().toString();
        
        if (keyPair) {
            // Create signature with consistent format
            const dataToSign = {
                roomName,
                timestamp,
                prevHash: lastMessageHash
            };
            
            const signature = signData(dataToSign);
            console.log('Generated signature for create room:', signature);
            sendSignedCreateRoom(roomName, signature, timestamp, lastMessageHash);
        } else if (watchOnlyKey) {
            const pendingData = {
                type: 'createRoom',
                data: {
                    roomName,
                    timestamp,
                    prevHash: lastMessageHash
                }
            };
            
            pendingAction = pendingData;
            
            // Show the signature modal with consistently formatted message
            document.getElementById('signatureMessage').textContent = prepareSignatureMessage(pendingData.data);
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

        // Prepare transfer data
        const transferInfo = prepareTransferData('roomTokenTransfer', recipientPublicKey, amount, currentRoomId);
        
        if (keyPair) {
            // Create signature with consistent format
            const dataToSign = {
                roomId: currentRoomId,
                recipientPublicKey,
                amount,
                timestamp: transferInfo.timestamp,
                prevHash: lastMessageHash
            };
            
            const signature = signData(dataToSign);
            console.log('Generated signature for room token transfer:', signature);
            sendSignedRoomTokenTransfer(
                currentRoomId, 
                recipientPublicKey, 
                amount, 
                signature, 
                transferInfo.timestamp, 
                lastMessageHash
            );
        } else if (watchOnlyKey) {
            pendingAction = transferInfo;
            
            // Show the signature modal with consistently formatted message
            document.getElementById('signatureMessage').textContent = prepareSignatureMessage(transferInfo.data);
            document.getElementById('signatureModal').style.display = 'block';
        } else {
            alert('Please load or generate a key first');
        }
    };

    // Hash token transfer
    document.getElementById('transferBtn').onclick = () => {
        const recipientPublicKey = document.getElementById('recipientPublicKey').value.trim();
        const amountStr = document.getElementById('transferAmount').value.trim();

        if (!recipientPublicKey || !amountStr) {
            alert('Please enter a valid recipient and amount');
            return;
        }

        const amount = parseInt(amountStr, 10);
        if (isNaN(amount) || amount <= 0) {
            alert('Please enter a valid amount');
            return;
        }

        // Prepare transfer data
        const transferInfo = prepareTransferData('transfer', recipientPublicKey, amount);
        
        if (keyPair) {
            // Create signature with consistent format
            const dataToSign = {
                recipientPublicKey,
                amount,
                timestamp: transferInfo.timestamp,
                prevHash: lastMessageHash
            };
            
            const signature = signData(dataToSign);
            console.log('Generated signature for transfer:', signature);
            sendSignedTransfer(
                recipientPublicKey, 
                amount, 
                signature, 
                transferInfo.timestamp, 
                lastMessageHash
            );
        } else if (watchOnlyKey) {
            pendingAction = transferInfo;
            
            // Show the signature modal with consistently formatted message
            document.getElementById('signatureMessage').textContent = prepareSignatureMessage(transferInfo.data);
            document.getElementById('signatureModal').style.display = 'block';
        }
    };
});

function sendSignedMessage(message, signature, timestamp, prevHashOverride) {
    const publicKey = keyPair ? keyPair.getPublic('hex') : watchOnlyKey;
    const prevHash = prevHashOverride || lastMessageHash;

    // Add debug information
    console.log('Sending message with signature:', {
        message,
        timestamp,
        signature: signature ? `${signature.substring(0, 10)}...` : 'undefined', // Show first 10 chars
        signatureType: typeof signature,
        signatureLength: signature ? signature.length : 0,
        publicKey: publicKey ? `${publicKey.substring(0, 10)}...` : 'undefined',
        prevHash: prevHash ? `${prevHash.substring(0, 10)}...` : 'undefined'
    });

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

    console.log('Sending transfer with:', {
        recipientPublicKey,
        amount: String(amount),
        timestamp,
        signature,
        publicKey,
        prevHash
    });

    ws.send(JSON.stringify({
        type: 'transfer',
        recipientPublicKey,
        amount: String(amount),
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

    console.log('Sending create room with:', {
        roomName,
        timestamp,
        signature,
        publicKey,
        prevHash
    });

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
    
    console.log('Sending room token transfer with:', {
        roomId,
        recipientPublicKey,
        amount: String(amount),
        timestamp,
        signature,
        publicKey,
        prevHash
    });

    ws.send(JSON.stringify({
        type: 'roomTokenTransfer',
        roomId,
        recipientPublicKey,
        amount: String(amount),
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
    
    // Show/hide key controls based on whether a key is set
    document.getElementById('forgetKeyBtn').style.display = hasKey ? 'inline-block' : 'none';
    document.getElementById('passphraseInput').style.display = hasKey ? 'none' : 'inline-block';
    document.getElementById('setKeyBtn').style.display = hasKey ? 'none' : 'inline-block';
    document.getElementById('watchOnlyInput').style.display = hasKey ? 'none' : 'inline-block';
    document.getElementById('setWatchOnlyBtn').style.display = hasKey ? 'none' : 'inline-block';
    
    if (hasKey) {
        const publicKey = keyPair ? keyPair.getPublic('hex') : watchOnlyKey;
        document.getElementById('publicKeyDisplay').textContent = `Public Key: ${publicKey}`;
        
        // Request token balance for current room
        if (currentRoomId) {
            requestRoomTokenBalance(currentRoomId);
        }
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
    if (!keyPair && !watchOnlyKey) return;
    
    const publicKey = keyPair ? keyPair.getPublic('hex') : watchOnlyKey;
    ws.send(JSON.stringify({
        type: 'getBalance',
        publicKey
    }));
}

function resetBalance() {
    document.getElementById('balance').textContent = 'Balance: 0 Hash';
    console.log('Balance reset');
}

function mine(puzzle, publicKey, difficulty) {
    if (!mining || !puzzle) return;
    
    // Add debug logging
    console.log(`Mining started: puzzle=${puzzle.substring(0, 10)}..., difficulty=${difficulty}`);
    document.getElementById('debugInfo').innerHTML += `Mining started: puzzle=${puzzle.substring(0, 10)}..., difficulty=${difficulty}\n`;
    
    // Try to find a valid nonce
    let nonce = Math.floor(Math.random() * 1000000000);
    const maxAttempts = 1000; // Limit attempts per batch to keep UI responsive
    
    for (let i = 0; i < maxAttempts && mining; i++) {
        // Check if this nonce works
        const data = puzzle + publicKey + nonce;
        // Double hash to match server verification
        const firstHash = CryptoJS.SHA256(data).toString();
        const hash = CryptoJS.SHA256(firstHash).toString();
        
        const isValid = hash.substring(0, difficulty) === '0'.repeat(difficulty);
        
        if (isValid) {
            // Found a valid nonce, submit it
            console.log(`Found valid nonce: ${nonce}, hash: ${hash}`);
            document.getElementById('debugInfo').innerHTML += `Found valid nonce: ${nonce}, hash: ${hash}\n`;
            
            ws.send(JSON.stringify({
                type: 'solution',
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
    } else {
        console.log('Mining stopped');
        document.getElementById('debugInfo').innerHTML += 'Mining stopped\n';
    }
}

// WebSocket message handler
ws.onmessage = (event) => {
    try {
        console.log('Received message:', event.data);
        const data = JSON.parse(event.data);
        
        if (data.type === 'puzzle') {
            // Received a new mining puzzle
            currentPuzzle = data.puzzle;
            // Update difficulty if provided by server
            if (data.difficulty) {
                currentDifficulty = data.difficulty;
            }
            console.log(`Received new puzzle: ${currentPuzzle.substring(0, 10)}..., difficulty: ${currentDifficulty}`);
            document.getElementById('debugInfo').innerHTML += `Received new puzzle: ${currentPuzzle.substring(0, 10)}..., difficulty: ${currentDifficulty}\n`;
            
            if (mining) {
                const publicKey = keyPair ? keyPair.getPublic('hex') : watchOnlyKey;
                mine(currentPuzzle, publicKey, currentDifficulty);
            }
        } else if (data.type === 'balance') {
            // Update balance display
            document.getElementById('balance').textContent = `Balance: ${data.balance} Hash`;
            console.log(`Balance updated: ${data.balance} Hash`);
            document.getElementById('debugInfo').innerHTML += `Balance updated: ${data.balance} Hash\n`;
        } else if (data.type === 'roomList') {
            // Update room list
            updateRoomList(data.rooms);
            
            // Update last message hash if provided
            if (data.messageHash) {
                lastMessageHash = data.messageHash;
            }
        } else if (data.type === 'roomHistory') {
            // Display chat history
            document.getElementById('messages').innerHTML = '';
            data.messages.forEach(msg => {
                const div = document.createElement('div');
                div.textContent = `${msg.message} (from ${msg.publicKey.slice(0,8)}...)`;
                document.getElementById('messages').appendChild(div);
            });
            document.getElementById('messages').scrollTop = document.getElementById('messages').scrollHeight;
            
            // Update last message hash from the most recent message
            if (data.messages.length > 0 && data.messages[data.messages.length - 1].messageHash) {
                lastMessageHash = data.messages[data.messages.length - 1].messageHash;
            }
        } else if (data.type === 'roomTokenBalance') {
            // Handle room token balance update
            console.log(`Room token balance updated: ${data.balance} for room ${data.roomId}`);
            
            // Update the UI to show room token balance
            const roomButtons = document.querySelectorAll('.room-item');
            roomButtons.forEach(button => {
                const roomId = button.getAttribute('data-room-id');
                if (roomId === data.roomId) {
                    // Find or create the balance span
                    let balanceSpan = button.querySelector('.room-token-balance');
                    if (!balanceSpan) {
                        balanceSpan = document.createElement('span');
                        balanceSpan.className = 'room-token-balance';
                        button.appendChild(balanceSpan);
                    }
                    balanceSpan.textContent = ` Token Balance: ${data.balance}`;
                }
            });
            
            // If this is the current room, update the room token display in the header
            if (data.roomId === currentRoomId) {
                const currentRoomElement = document.getElementById('currentRoom');
                currentRoomElement.textContent = `Current Room: ${getRoomNameById(data.roomId)} (Token Balance: ${data.balance})`;
            }
            
            // Update lastMessageHash if provided in the response
            if (data.messageHash) {
                console.log('Updating lastMessageHash from roomTokenBalance:', data.messageHash);
                lastMessageHash = data.messageHash;
            }
        } else if (data.messageHash) {
            // This is a regular chat message (no type field but has messageHash)
            const div = document.createElement('div');
            div.textContent = `${data.message} (from ${data.publicKey.slice(0,8)}...)`;
            document.getElementById('messages').appendChild(div);
            document.getElementById('messages').scrollTop = document.getElementById('messages').scrollHeight;
            
            // Update last message hash
            lastMessageHash = data.messageHash;
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
        button.setAttribute('data-room-id', room.id);
        
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
    
    // Update current room display with token balance if available
    if (currentRoomId) {
        const currentRoom = rooms.find(room => room.id === currentRoomId);
        if (currentRoom) {
            const currentRoomElement = document.getElementById('currentRoom');
            let displayText = `Current Room: ${currentRoom.name}`;
            if (currentRoom.tokenBalance !== undefined) {
                displayText += ` (Token Balance: ${currentRoom.tokenBalance})`;
            }
            currentRoomElement.textContent = displayText;
        }
    }
}

function joinRoom(roomId) {
    currentRoomId = roomId;
    ws.send(JSON.stringify({
        type: 'joinRoom',
        roomId
    }));
    
    // Request token balance for this room
    requestRoomTokenBalance(roomId);
}

function requestRoomTokenBalance(roomId) {
    const publicKey = keyPair ? keyPair.getPublic('hex') : watchOnlyKey;
    if (publicKey) {
        ws.send(JSON.stringify({
            type: 'getRoomTokenBalance',
            roomId,
            publicKey
        }));
    }
}

function getRoomNameById(roomId) {
    const roomButtons = document.querySelectorAll('.room-item');
    for (const button of roomButtons) {
        if (button.getAttribute('data-room-id') === roomId) {
            const nameSpan = button.querySelector('span:not(.room-creator):not(.room-token-balance)');
            if (nameSpan) {
                return nameSpan.textContent;
            }
        }
    }
    return roomId === 'general' ? 'General' : roomId;
}

// Utility function to sign data with consistent formatting
function signData(dataObject) {
    // Convert all values to strings and concatenate them in a consistent order
    const stringifiedData = Object.values(dataObject).map(val => String(val)).join('');
    console.log('Signing data:', stringifiedData, 'with data object:', dataObject);
    
    if (keyPair) {
        return keyPair.sign(stringifiedData).toDER('hex');
    }
    return null;
}

// Utility function to prepare message for signature in watch-only mode
function prepareSignatureMessage(dataObject) {
    return Object.values(dataObject).map(val => String(val)).join('');
}

// Utility function to create a common data structure for token transfers
function prepareTransferData(type, recipientPublicKey, amount, roomId = null) {
    const timestamp = Date.now().toString();
    const data = {
        recipientPublicKey,
        amount: amount.toString(),
        timestamp,
        prevHash: lastMessageHash
    };
    
    // Add roomId for room token transfers
    if (roomId) {
        data.roomId = roomId;
    }
    
    return {
        type,
        data,
        timestamp
    };
} 