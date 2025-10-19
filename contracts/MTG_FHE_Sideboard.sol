pragma solidity ^0.8.24;
import { FHE, euint32, ebool } from "@fhevm/solidity/lib/FHE.sol";
import { SepoliaConfig } from "@fhevm/solidity/config/ZamaConfig.sol";

contract MTGSideboardFHE is SepoliaConfig {
    using FHE for euint32;
    using FHE for ebool;

    error NotOwner();
    error NotProvider();
    error Paused();
    error RateLimited();
    error InvalidState();
    error BatchClosed();
    error BatchFull();
    error InvalidBatch();
    error StaleWrite();
    error InvalidDecryption();

    event ProviderAdded(address indexed provider);
    event ProviderRemoved(address indexed provider);
    event Paused();
    event Unpaused();
    event CooldownUpdated(uint256 newCooldown);
    event BatchOpened(uint256 indexed batchId, address indexed opener);
    event BatchClosed(uint256 indexed batchId, address indexed closer);
    event SideboardCommitted(uint256 indexed batchId, address indexed committer);
    event DecryptionRequested(uint256 indexed requestId, uint256 indexed batchId, address indexed requester);
    event DecryptionComplete(uint256 indexed requestId, uint256 indexed batchId, uint256 publicMetric);

    bool public paused;
    uint256 public constant MIN_INTERVAL = 5 seconds;
    mapping(address => uint256) public lastActionAt;
    mapping(address => bool) public isProvider;
    uint256 public cooldownSeconds = 10;
    uint256 public currentBatchId;
    uint256 public modelVersion;
    mapping(uint256 => Batch) public batches;
    mapping(uint256 => DecryptionContext) public decryptionContexts;

    struct EncryptedSideboard {
        euint32 encryptedValue;
        uint256 version;
    }

    struct Batch {
        bool isOpen;
        uint256 currentSize;
        uint256 maxSize;
        mapping(uint256 => EncryptedSideboard) sideboards;
    }

    struct DecryptionContext {
        uint256 batchId;
        uint256 modelVersion;
        bytes32 stateHash;
        bool processed;
        address requester;
    }

    modifier onlyOwner() {
        if (msg.sender != owner()) revert NotOwner();
        _;
    }

    modifier onlyProvider() {
        if (!isProvider[msg.sender]) revert NotProvider();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert Paused();
        _;
    }

    modifier rateLimited() {
        if (block.timestamp < lastActionAt[msg.sender] + cooldownSeconds) {
            revert RateLimited();
        }
        lastActionAt[msg.sender] = block.timestamp;
        _;
    }

    function initialize() external initializer {
        modelVersion = 1;
        currentBatchId = 1;
        _openBatch(currentBatchId, 10);
    }

    function setCooldown(uint256 newCooldown) external onlyOwner {
        cooldownSeconds = newCooldown;
        emit CooldownUpdated(newCooldown);
    }

    function addProvider(address provider) external onlyOwner {
        isProvider[provider] = true;
        emit ProviderAdded(provider);
    }

    function removeProvider(address provider) external onlyOwner {
        isProvider[provider] = false;
        emit ProviderRemoved(provider);
    }

    function pause() external onlyOwner whenNotPaused {
        paused = true;
        emit Paused();
    }

    function unpause() external onlyOwner {
        paused = false;
        emit Unpaused();
    }

    function openBatch(uint256 maxSize) external onlyOwner {
        currentBatchId++;
        _openBatch(currentBatchId, maxSize);
    }

    function closeBatch(uint256 batchId) external onlyOwner {
        Batch storage batch = batches[batchId];
        if (!batch.isOpen) revert BatchClosed();
        batch.isOpen = false;
        emit BatchClosed(batchId, msg.sender);
    }

    function commitEncryptedSideboard(uint256 batchId, euint32 encryptedValue) external onlyProvider whenNotPaused rateLimited {
        Batch storage batch = batches[batchId];
        if (!batch.isOpen) revert BatchClosed();
        if (batch.currentSize >= batch.maxSize) revert BatchFull();

        batch.currentSize++;
        batch.sideboards[batch.currentSize] = EncryptedSideboard(encryptedValue, modelVersion);
        emit SideboardCommitted(batchId, msg.sender);
    }

    function requestBatchDecryption(uint256 batchId) external onlyProvider whenNotPaused rateLimited {
        Batch storage batch = batches[batchId];
        if (batch.currentSize == 0) revert InvalidBatch();

        euint32 memory acc = FHE.asEuint32(0);
        for (uint256 i = 1; i <= batch.currentSize; i++) {
            EncryptedSideboard storage sideboard = batch.sideboards[i];
            if (sideboard.version != modelVersion) revert StaleWrite();
            _requireInitialized(sideboard.encryptedValue, "Sideboard value");
            acc = FHE.add(acc, sideboard.encryptedValue);
        }

        bytes32[] memory cts = new bytes32[](1);
        cts[0] = FHE.toBytes32(acc);
        bytes32 stateHash = _hashCiphertexts(cts);

        uint256 requestId = FHE.requestDecryption(cts, this.onBatchDecrypted.selector);
        decryptionContexts[requestId] = DecryptionContext(batchId, modelVersion, stateHash, false, msg.sender);
        emit DecryptionRequested(requestId, batchId, msg.sender);
    }

    function onBatchDecrypted(uint256 requestId, bytes memory cleartexts, bytes memory proof) public {
        if (decryptionContexts[requestId].processed) revert InvalidDecryption();

        DecryptionContext storage context = decryptionContexts[requestId];
        Batch storage batch = batches[context.batchId];

        bytes32[] memory cts = new bytes32[](1);
        euint32 memory acc = FHE.asEuint32(0);
        for (uint256 i = 1; i <= batch.currentSize; i++) {
            EncryptedSideboard storage sideboard = batch.sideboards[i];
            if (sideboard.version != context.modelVersion) revert StaleWrite();
            _requireInitialized(sideboard.encryptedValue, "Sideboard value");
            acc = FHE.add(acc, sideboard.encryptedValue);
        }
        cts[0] = FHE.toBytes32(acc);

        bytes32 currHash = _hashCiphertexts(cts);
        if (currHash != context.stateHash) revert InvalidState();

        FHE.checkSignatures(requestId, cleartexts, proof);

        uint256 publicMetric = abi.decode(cleartexts, (uint256));
        context.processed = true;
        emit DecryptionComplete(requestId, context.batchId, publicMetric);
    }

    function _openBatch(uint256 batchId, uint256 maxSize) private {
        batches[batchId] = Batch(true, 0, maxSize);
        emit BatchOpened(batchId, msg.sender);
    }

    function _hashCiphertexts(bytes32[] memory cts) private view returns (bytes32) {
        return keccak256(abi.encode(cts, address(this)));
    }

    function _initIfNeeded(euint32 x) private view returns (euint32) {
        if (!FHE.isInitialized(x)) {
            return FHE.asEuint32(0);
        }
        return x;
    }

    function _requireInitialized(euint32 x, string memory tag) private view {
        if (!FHE.isInitialized(x)) {
            revert(string(abi.encodePacked(tag, " not initialized")));
        }
    }
}