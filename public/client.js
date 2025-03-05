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
    
    try {
        // Request room list when connection is established
        ws.send(JSON.stringify({
            type: 'getRoomList',
            publicKey: watchOnlyKey || (keyPair ? keyPair.getPublic('hex') : null)
        }));
        
        // Synchronize hash if we have a key
        if (keyPair || watchOnlyKey) {
            // Wait a bit to ensure the connection is fully established
            setTimeout(() => {
                synchronizeLastMessageHash();
            }, 500);
        }
    } catch (error) {
        console.error('Error in WebSocket onopen handler:', error);
    }
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
    // Add mining controls to HTML
    document.getElementById('keyControls').innerHTML += `
        <div id="miningControls" style="margin-top: 10px;">
            <button id="startMining" disabled>Start Mining</button>
            <button id="stopMining" disabled>Stop Mining</button>
        </div>
        <button id="syncHashBtn" style="margin-left: 10px;">Sync Hash</button>
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

    document.getElementById('setKeyBtn').onclick = function() {
        try {
            // Get the passphrase
            const passphrase = document.getElementById('passphraseInput').value.trim();
            if (!passphrase) {
                alert('Please enter a passphrase');
                return;
            }
            
            // Clear the input field
            document.getElementById('passphraseInput').value = '';
            
            // Generate the key pair
            const hash = CryptoJS.SHA256(passphrase).toString();
            keyPair = ec.keyFromPrivate(hash.substring(0, 64), 'hex');
            watchOnlyKey = null;
            
            // Log success
            const publicKeyHex = keyPair.getPublic('hex');
            console.log('Key set successfully. Public key:', publicKeyHex);
            updateDebugInfo(`Key set successfully. Public key: ${publicKeyHex.substring(0, 8)}...`);
            
            // Update UI
            document.getElementById('publicKeyDisplay').textContent = `Public Key: ${publicKeyHex}`;
            document.getElementById('forgetKeyBtn').style.display = 'inline-block';
            document.getElementById('passphraseInput').style.display = 'none';
            document.getElementById('setKeyBtn').style.display = 'none';
            document.getElementById('watchOnlyInput').style.display = 'none';
            document.getElementById('setWatchOnlyBtn').style.display = 'none';
            
            // Enable buttons
            document.getElementById('messageInput').disabled = false;
            document.getElementById('sendBtn').disabled = false;
            document.getElementById('transferBtn').disabled = false;
            document.getElementById('createRoomBtn').disabled = false;
            document.getElementById('sendRoomTokenBtn').disabled = false;
            document.getElementById('startMining').disabled = false;
            document.getElementById('syncHashBtn').disabled = false;
            
            // Request balance
            ws.send(JSON.stringify({
                type: 'getBalance',
                publicKey: publicKeyHex
            }));
            
            // Request room list
            ws.send(JSON.stringify({
                type: 'getRoomList',
                publicKey: publicKeyHex
            }));
            
            // Synchronize hash
            setTimeout(function() {
                ws.send(JSON.stringify({
                    type: 'getLastMessageHash',
                    publicKey: publicKeyHex
                }));
            }, 500);
            
        } catch (error) {
            console.error('Error setting key:', error);
            alert('Error setting key: ' + error.message);
        }
    };

    document.getElementById('setWatchOnlyBtn').onclick = function() {
        try {
            // Get the public key
            const publicKeyHex = document.getElementById('watchOnlyInput').value.trim();
            if (!publicKeyHex) {
                alert('Please enter a public key');
                return;
            }
            
            // Clear the input field
            document.getElementById('watchOnlyInput').value = '';
            
            // Validate the public key
            ec.keyFromPublic(publicKeyHex, 'hex');
            
            // Set the watch-only key
            keyPair = null;
            watchOnlyKey = publicKeyHex;
            
            // Log success
            console.log('Watch-only mode enabled. Public key:', publicKeyHex);
            updateDebugInfo(`Watch-only mode enabled. Public key: ${publicKeyHex.substring(0, 8)}...`);
            
            // Update UI
            document.getElementById('publicKeyDisplay').textContent = `Public Key (Watch-only): ${publicKeyHex}`;
            document.getElementById('forgetKeyBtn').style.display = 'inline-block';
            document.getElementById('passphraseInput').style.display = 'none';
            document.getElementById('setKeyBtn').style.display = 'none';
            document.getElementById('watchOnlyInput').style.display = 'none';
            document.getElementById('setWatchOnlyBtn').style.display = 'none';
            
            // Enable buttons
            document.getElementById('messageInput').disabled = false;
            document.getElementById('sendBtn').disabled = false;
            document.getElementById('transferBtn').disabled = false;
            document.getElementById('createRoomBtn').disabled = false;
            document.getElementById('sendRoomTokenBtn').disabled = false;
            document.getElementById('startMining').disabled = false;
            document.getElementById('syncHashBtn').disabled = false;
            
            // Request balance
            ws.send(JSON.stringify({
                type: 'getBalance',
                publicKey: publicKeyHex
            }));
            
            // Request room list
            ws.send(JSON.stringify({
                type: 'getRoomList',
                publicKey: publicKeyHex
            }));
            
            // Synchronize hash
            setTimeout(function() {
                ws.send(JSON.stringify({
                    type: 'getLastMessageHash',
                    publicKey: publicKeyHex
                }));
            }, 500);
            
        } catch (error) {
            console.error('Error setting watch-only key:', error);
            alert('Invalid public key format: ' + error.message);
        }
    };

    document.getElementById('forgetKeyBtn').onclick = function() {
        try {
            // Clear the keys
            keyPair = null;
            watchOnlyKey = null;
            
            // Log success
            console.log('Key forgotten');
            updateDebugInfo('Key forgotten');
            
            // Update UI
            document.getElementById('publicKeyDisplay').textContent = '';
            document.getElementById('balance').textContent = 'Balance: 0 Hash';
            document.getElementById('forgetKeyBtn').style.display = 'none';
            document.getElementById('passphraseInput').style.display = 'inline-block';
            document.getElementById('setKeyBtn').style.display = 'inline-block';
            document.getElementById('watchOnlyInput').style.display = 'inline-block';
            document.getElementById('setWatchOnlyBtn').style.display = 'inline-block';
            
            // Disable buttons
            document.getElementById('messageInput').disabled = true;
            document.getElementById('sendBtn').disabled = true;
            document.getElementById('transferBtn').disabled = true;
            document.getElementById('createRoomBtn').disabled = true;
            document.getElementById('sendRoomTokenBtn').disabled = true;
            document.getElementById('startMining').disabled = true;
            document.getElementById('syncHashBtn').disabled = true;
            
            // Request room list with no key
            ws.send(JSON.stringify({
                type: 'getRoomList',
                publicKey: null
            }));
            
        } catch (error) {
            console.error('Error forgetting key:', error);
            updateDebugInfo(`Error forgetting key: ${error.message}`);
        }
    };

    document.getElementById('sendBtn').onclick = () => {
        // First synchronize the hash
        synchronizeLastMessageHash();
        
        setTimeout(() => {
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
        }, 500); // Wait for hash synchronization to complete
    };

    document.getElementById('createRoomBtn').onclick = () => {
        // First synchronize the hash
        synchronizeLastMessageHash();
        
        setTimeout(() => {
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
        }, 500); // Wait for hash synchronization to complete
    };

    // Room token transfer
    const sendRoomTokenBtn = document.getElementById('sendRoomTokenBtn');
    sendRoomTokenBtn.onclick = () => {
        // First synchronize the hash
        synchronizeLastMessageHash();
        
        setTimeout(() => {
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
        }, 500); // Wait for hash synchronization to complete
    };

    // Add a synchronize button to the UI
    document.getElementById('keyControls').innerHTML += `
        <button id="syncHashBtn" style="margin-left: 10px;">Sync Hash</button>
    `;
    
    // Add click handler for the sync button
    document.getElementById('syncHashBtn').onclick = () => {
        synchronizeLastMessageHash();
    };

    // Hash token transfer
    document.getElementById('transferBtn').onclick = () => {
        // First synchronize the hash
        synchronizeLastMessageHash();
        
        setTimeout(() => {
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
        }, 500); // Wait for hash synchronization to complete
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
    
    try {
        document.getElementById('messageInput').disabled = !hasKey;
        document.getElementById('sendBtn').disabled = !hasKey;
        document.getElementById('transferBtn').disabled = !hasKey;
        document.getElementById('createRoomBtn').disabled = !hasKey;
        document.getElementById('sendRoomTokenBtn').disabled = !hasKey;
        document.getElementById('startMining').disabled = !hasKey;
        document.getElementById('syncHashBtn').disabled = !hasKey;
        
        // Show/hide key controls based on whether a key is set
        document.getElementById('forgetKeyBtn').style.display = hasKey ? 'inline-block' : 'none';
        document.getElementById('passphraseInput').style.display = hasKey ? 'none' : 'inline-block';
        document.getElementById('setKeyBtn').style.display = hasKey ? 'none' : 'inline-block';
        document.getElementById('watchOnlyInput').style.display = hasKey ? 'none' : 'inline-block';
        document.getElementById('setWatchOnlyBtn').style.display = hasKey ? 'none' : 'inline-block';
        
        if (hasKey) {
            const publicKey = keyPair ? keyPair.getPublic('hex') : watchOnlyKey;
            document.getElementById('publicKeyDisplay').textContent = `Public Key: ${publicKey}`;
            
            // Add current hash to debug info
            updateDebugInfo(`Current key: ${publicKey.substring(0, 8)}..., lastMessageHash: ${lastMessageHash.substring(0, 16)}...`);
            
            // Request token balance for current room
            if (currentRoomId) {
                requestRoomTokenBalance(currentRoomId);
            }
        } else {
            document.getElementById('publicKeyDisplay').textContent = '';
        }
    } catch (error) {
        console.error('Error updating UI state:', error);
        updateDebugInfo(`Error updating UI state: ${error.message}`);
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
        
        // Add to debug info
        updateDebugInfo(`Received: ${data.type || 'message'}`);
        
        if (data.type === 'puzzle') {
            // Received a new mining puzzle
            currentPuzzle = data.puzzle;
            // Update difficulty if provided by server
            if (data.difficulty) {
                currentDifficulty = data.difficulty;
            }
            console.log(`Received new puzzle: ${currentPuzzle.substring(0, 10)}..., difficulty: ${currentDifficulty}`);
            updateDebugInfo(`Received new puzzle: ${currentPuzzle.substring(0, 10)}..., difficulty: ${currentDifficulty}`);
            
            if (mining) {
                const publicKey = keyPair ? keyPair.getPublic('hex') : watchOnlyKey;
                mine(currentPuzzle, publicKey, currentDifficulty);
            }
        } else if (data.type === 'balance') {
            // Update balance display
            document.getElementById('balance').textContent = `Balance: ${data.balance} Hash`;
            console.log(`Balance updated: ${data.balance} Hash`);
            updateDebugInfo(`Balance updated: ${data.balance} Hash`);
            
            // Update last message hash if provided
            if (data.messageHash) {
                console.log('Updating lastMessageHash from balance:', data.messageHash);
                lastMessageHash = data.messageHash;
                updateDebugInfo(`Updated lastMessageHash: ${data.messageHash.substring(0, 16)}...`);
            }
        } else if (data.type === 'roomList') {
            // Update room list
            updateRoomList(data.rooms);
            
            // Update last message hash if provided
            if (data.messageHash) {
                console.log('Updating lastMessageHash from roomList:', data.messageHash);
                lastMessageHash = data.messageHash;
                updateDebugInfo(`Updated lastMessageHash from roomList: ${data.messageHash.substring(0, 16)}...`);
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
                const newHash = data.messages[data.messages.length - 1].messageHash;
                console.log('Updating lastMessageHash from roomHistory:', newHash);
                lastMessageHash = newHash;
                updateDebugInfo(`Updated lastMessageHash from roomHistory: ${newHash.substring(0, 16)}...`);
            }
        } else if (data.type === 'roomTokenBalance') {
            // Handle room token balance update
            console.log(`Room token balance updated: ${data.balance} for room ${data.roomId}`);
            updateDebugInfo(`Room token balance updated: ${data.balance} for room ${data.roomId}`);
            
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
                updateDebugInfo(`Updated lastMessageHash from roomTokenBalance: ${data.messageHash.substring(0, 16)}...`);
            }
        } else if (data.type === 'lastMessageHash') {
            // Update the last message hash from server
            console.log('Received last message hash from server:', data.lastMessageHash);
            updateDebugInfo(`Received last message hash: ${data.lastMessageHash.substring(0, 16)}...`);
            
            // Update the last message hash
            lastMessageHash = data.lastMessageHash;
        } else if (data.messageHash) {
            // This is a regular chat message (no type field but has messageHash)
            const div = document.createElement('div');
            div.textContent = `${data.message} (from ${data.publicKey.slice(0,8)}...)`;
            document.getElementById('messages').appendChild(div);
            document.getElementById('messages').scrollTop = document.getElementById('messages').scrollHeight;
            
            // Update last message hash
            console.log('Updating lastMessageHash from message:', data.messageHash);
            lastMessageHash = data.messageHash;
            updateDebugInfo(`Updated lastMessageHash from message: ${data.messageHash.substring(0, 16)}...`);
        }
    } catch (error) {
        console.error('Error handling WebSocket message:', error);
        updateDebugInfo(`Error handling WebSocket message: ${error.message}`);
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
    if (!rooms.has(roomId)) return;
    
    currentRoomId = roomId;
    
    // Update UI to show current room
    document.querySelectorAll('.room-item').forEach(button => {
        if (button.getAttribute('data-room-id') === roomId) {
            button.classList.add('active-room');
        } else {
            button.classList.remove('active-room');
        }
    });
    
    // Update current room display
    document.getElementById('currentRoom').textContent = `Current Room: ${getRoomNameById(roomId)}`;
    
    // Request room history
    ws.send(JSON.stringify({
        type: 'joinRoom',
        roomId: roomId
    }));
    
    // Request room token balance
    requestRoomTokenBalance(roomId);
    
    // Synchronize the last message hash with the server
    synchronizeLastMessageHash();
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

// Add this function after the other utility functions
function synchronizeLastMessageHash() {
    if (!keyPair && !watchOnlyKey) {
        console.log('Cannot synchronize hash: no key available');
        updateDebugInfo('Cannot synchronize hash: no key available');
        return;
    }
    
    try {
        const publicKey = keyPair ? keyPair.getPublic('hex') : watchOnlyKey;
        console.log('Requesting hash synchronization for public key:', publicKey);
        updateDebugInfo(`Requesting hash synchronization for: ${publicKey.substring(0, 8)}...`);
        
        ws.send(JSON.stringify({
            type: 'getLastMessageHash',
            publicKey: publicKey
        }));
    } catch (error) {
        console.error('Error synchronizing hash:', error);
        updateDebugInfo(`Error synchronizing hash: ${error.message}`);
    }
}

// Add a function to safely update debug info
function updateDebugInfo(message) {
    const debugInfo = document.getElementById('debugInfo');
    if (debugInfo) {
        debugInfo.innerHTML += message + '\n';
        // Scroll to bottom
        debugInfo.scrollTop = debugInfo.scrollHeight;
    }
} 