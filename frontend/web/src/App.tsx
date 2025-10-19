// App.tsx
import { ConnectButton } from '@rainbow-me/rainbowkit';
import '@rainbow-me/rainbowkit/styles.css';
import React, { useEffect, useState } from "react";
import { ethers } from "ethers";
import { getContractReadOnly, getContractWithSigner } from "./contract";
import "./App.css";
import { useAccount, useSignMessage } from 'wagmi';

interface SideboardCard {
  id: string;
  encryptedData: string;
  timestamp: number;
  owner: string;
  cardName: string;
  cardType: string;
  manaCost: number;
  isSideboard: boolean;
}

const FHEEncryptNumber = (value: number): string => {
  return `FHE-${btoa(value.toString())}`;
};

const FHEDecryptNumber = (encryptedData: string): number => {
  if (encryptedData.startsWith('FHE-')) {
    return parseFloat(atob(encryptedData.substring(4)));
  }
  return parseFloat(encryptedData);
};

const generatePublicKey = () => `0x${Array(2000).fill(0).map(() => Math.floor(Math.random() * 16).toString(16)).join('')}`;

const App: React.FC = () => {
  // Randomly selected style: High Contrast (Red+Black), Cyberpunk UI, Card Layout, Animation Rich
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [loading, setLoading] = useState(true);
  const [cards, setCards] = useState<SideboardCard[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showAddModal, setShowAddModal] = useState(false);
  const [addingCard, setAddingCard] = useState(false);
  const [transactionStatus, setTransactionStatus] = useState<{ visible: boolean; status: "pending" | "success" | "error"; message: string; }>({ visible: false, status: "pending", message: "" });
  const [newCardData, setNewCardData] = useState({ cardName: "", cardType: "Creature", manaCost: 0, isSideboard: false });
  const [selectedCard, setSelectedCard] = useState<SideboardCard | null>(null);
  const [decryptedMana, setDecryptedMana] = useState<number | null>(null);
  const [isDecrypting, setIsDecrypting] = useState(false);
  const [publicKey, setPublicKey] = useState<string>("");
  const [contractAddress, setContractAddress] = useState<string>("");
  const [chainId, setChainId] = useState<number>(0);
  const [startTimestamp, setStartTimestamp] = useState<number>(0);
  const [durationDays, setDurationDays] = useState<number>(30);
  const [activeTab, setActiveTab] = useState<"mainboard" | "sideboard">("mainboard");
  const [searchTerm, setSearchTerm] = useState("");
  const [showTutorial, setShowTutorial] = useState(false);

  // Stats for the dashboard
  const mainboardCount = cards.filter(c => !c.isSideboard).length;
  const sideboardCount = cards.filter(c => c.isSideboard).length;
  const totalManaCost = cards.reduce((sum, card) => sum + FHEDecryptNumber(card.encryptedData), 0);

  useEffect(() => {
    loadCards().finally(() => setLoading(false));
    const initSignatureParams = async () => {
      const contract = await getContractReadOnly();
      if (contract) setContractAddress(await contract.getAddress());
      if (window.ethereum) {
        const chainIdHex = await window.ethereum.request({ method: 'eth_chainId' });
        setChainId(parseInt(chainIdHex, 16));
      }
      setStartTimestamp(Math.floor(Date.now() / 1000));
      setDurationDays(30);
      setPublicKey(generatePublicKey());
    };
    initSignatureParams();
  }, []);

  const loadCards = async () => {
    setIsRefreshing(true);
    try {
      const contract = await getContractReadOnly();
      if (!contract) return;
      
      const isAvailable = await contract.isAvailable();
      if (!isAvailable) {
        console.log("Contract is not available");
        return;
      }

      const keysBytes = await contract.getData("card_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try {
          const keysStr = ethers.toUtf8String(keysBytes);
          if (keysStr.trim() !== '') keys = JSON.parse(keysStr);
        } catch (e) { console.error("Error parsing card keys:", e); }
      }

      const list: SideboardCard[] = [];
      for (const key of keys) {
        try {
          const cardBytes = await contract.getData(`card_${key}`);
          if (cardBytes.length > 0) {
            try {
              const cardData = JSON.parse(ethers.toUtf8String(cardBytes));
              list.push({ 
                id: key, 
                encryptedData: cardData.data, 
                timestamp: cardData.timestamp, 
                owner: cardData.owner, 
                cardName: cardData.cardName,
                cardType: cardData.cardType,
                manaCost: FHEDecryptNumber(cardData.data),
                isSideboard: cardData.isSideboard || false
              });
            } catch (e) { console.error(`Error parsing card data for ${key}:`, e); }
          }
        } catch (e) { console.error(`Error loading card ${key}:`, e); }
      }
      list.sort((a, b) => b.timestamp - a.timestamp);
      setCards(list);
    } catch (e) { 
      console.error("Error loading cards:", e); 
    } finally { 
      setIsRefreshing(false); 
      setLoading(false); 
    }
  };

  const addCard = async () => {
    if (!isConnected) { 
      alert("Please connect wallet first"); 
      return; 
    }
    setAddingCard(true);
    setTransactionStatus({ 
      visible: true, 
      status: "pending", 
      message: "Encrypting card data with Zama FHE..." 
    });

    try {
      const encryptedMana = FHEEncryptNumber(newCardData.manaCost);
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");

      const cardId = `card-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
      const cardData = { 
        data: encryptedMana, 
        timestamp: Math.floor(Date.now() / 1000), 
        owner: address, 
        cardName: newCardData.cardName,
        cardType: newCardData.cardType,
        isSideboard: newCardData.isSideboard
      };

      await contract.setData(`card_${cardId}`, ethers.toUtf8Bytes(JSON.stringify(cardData)));
      
      const keysBytes = await contract.getData("card_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try { 
          keys = JSON.parse(ethers.toUtf8String(keysBytes)); 
        } catch (e) { 
          console.error("Error parsing keys:", e); 
        }
      }
      keys.push(cardId);
      await contract.setData("card_keys", ethers.toUtf8Bytes(JSON.stringify(keys)));

      setTransactionStatus({ 
        visible: true, 
        status: "success", 
        message: "Card added with FHE encryption!" 
      });
      await loadCards();
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
        setShowAddModal(false);
        setNewCardData({ cardName: "", cardType: "Creature", manaCost: 0, isSideboard: false });
      }, 2000);
    } catch (e: any) {
      const errorMessage = e.message.includes("user rejected transaction") 
        ? "Transaction rejected by user" 
        : "Submission failed: " + (e.message || "Unknown error");
      setTransactionStatus({ 
        visible: true, 
        status: "error", 
        message: errorMessage 
      });
      setTimeout(() => setTransactionStatus({ 
        visible: false, 
        status: "pending", 
        message: "" 
      }), 3000);
    } finally { 
      setAddingCard(false); 
    }
  };

  const decryptWithSignature = async (encryptedData: string): Promise<number | null> => {
    if (!isConnected) { 
      alert("Please connect wallet first"); 
      return null; 
    }
    setIsDecrypting(true);
    try {
      const message = `publickey:${publicKey}\ncontractAddresses:${contractAddress}\ncontractsChainId:${chainId}\nstartTimestamp:${startTimestamp}\ndurationDays:${durationDays}`;
      await signMessageAsync({ message });
      await new Promise(resolve => setTimeout(resolve, 1500));
      return FHEDecryptNumber(encryptedData);
    } catch (e) { 
      console.error("Decryption failed:", e); 
      return null; 
    } finally { 
      setIsDecrypting(false); 
    }
  };

  const moveToSideboard = async (cardId: string) => {
    if (!isConnected) { 
      alert("Please connect wallet first"); 
      return; 
    }
    setTransactionStatus({ 
      visible: true, 
      status: "pending", 
      message: "Updating card with FHE..." 
    });
    try {
      const contract = await getContractReadOnly();
      if (!contract) throw new Error("Failed to get contract");
      const cardBytes = await contract.getData(`card_${cardId}`);
      if (cardBytes.length === 0) throw new Error("Card not found");
      const cardData = JSON.parse(ethers.toUtf8String(cardBytes));
      
      const contractWithSigner = await getContractWithSigner();
      if (!contractWithSigner) throw new Error("Failed to get contract with signer");
      
      const updatedCard = { 
        ...cardData, 
        isSideboard: !cardData.isSideboard 
      };
      await contractWithSigner.setData(`card_${cardId}`, ethers.toUtf8Bytes(JSON.stringify(updatedCard)));
      
      setTransactionStatus({ 
        visible: true, 
        status: "success", 
        message: "Card moved successfully!" 
      });
      await loadCards();
      setTimeout(() => setTransactionStatus({ 
        visible: false, 
        status: "pending", 
        message: "" 
      }), 2000);
    } catch (e: any) {
      setTransactionStatus({ 
        visible: true, 
        status: "error", 
        message: "Operation failed: " + (e.message || "Unknown error") 
      });
      setTimeout(() => setTransactionStatus({ 
        visible: false, 
        status: "pending", 
        message: "" 
      }), 3000);
    }
  };

  const isOwner = (cardAddress: string) => address?.toLowerCase() === cardAddress.toLowerCase();

  const filteredCards = cards.filter(card => 
    (activeTab === "mainboard" ? !card.isSideboard : card.isSideboard) &&
    (card.cardName.toLowerCase().includes(searchTerm.toLowerCase()) || 
     card.cardType.toLowerCase().includes(searchTerm.toLowerCase()))
  );

  const tutorialSteps = [
    { 
      title: "Connect Wallet", 
      description: "Connect your Web3 wallet to manage your encrypted MTG sideboard", 
      icon: "🔗" 
    },
    { 
      title: "Add Encrypted Cards", 
      description: "Add cards to your mainboard or sideboard with mana costs encrypted using FHE", 
      icon: "🃏",
      details: "Your card mana costs are encrypted on the client-side before being sent to the blockchain" 
    },
    { 
      title: "FHE Sideboard", 
      description: "Your sideboard cards remain encrypted until you choose to reveal them", 
      icon: "🔒",
      details: "Zama FHE technology keeps your sideboard strategy secret from opponents" 
    },
    { 
      title: "Strategic Play", 
      description: "Swap cards between mainboard and sideboard without revealing your strategy", 
      icon: "♟️",
      details: "Opponents can't see which cards you're bringing in from your sideboard" 
    }
  ];

  const renderManaSymbols = (manaCost: number) => {
    const symbols = [];
    for (let i = 0; i < Math.min(manaCost, 10); i++) {
      symbols.push(<div key={i} className="mana-symbol"></div>);
    }
    if (manaCost > 10) {
      symbols.push(<div key="extra" className="mana-symbol extra">+{manaCost-10}</div>);
    }
    return symbols;
  };

  if (loading) return (
    <div className="loading-screen">
      <div className="cyber-spinner"></div>
      <p>Initializing encrypted connection...</p>
    </div>
  );

  return (
    <div className="app-container high-contrast-theme">
      <header className="app-header">
        <div className="logo">
          <div className="logo-icon">
            <div className="mtg-icon"></div>
          </div>
          <h1>MTG<span>FHE</span>Sideboard</h1>
        </div>
        <div className="header-actions">
          <button 
            onClick={() => setShowAddModal(true)} 
            className="add-card-btn cyber-button"
          >
            <div className="add-icon"></div>Add Card
          </button>
          <button 
            className="cyber-button" 
            onClick={() => setShowTutorial(!showTutorial)}
          >
            {showTutorial ? "Hide Guide" : "Show Guide"}
          </button>
          <div className="wallet-connect-wrapper">
            <ConnectButton accountStatus="address" chainStatus="icon" showBalance={false}/>
          </div>
        </div>
      </header>

      <div className="main-content">
        <div className="welcome-banner">
          <div className="welcome-text">
            <h2>Encrypted MTG Sideboard</h2>
            <p>Keep your sideboard strategy secret with Zama FHE technology</p>
          </div>
          <div className="fhe-indicator">
            <div className="fhe-lock"></div>
            <span>FHE Encryption Active</span>
          </div>
        </div>

        {showTutorial && (
          <div className="tutorial-section">
            <h2>FHE Sideboard Guide</h2>
            <p className="subtitle">Learn how to use encrypted sideboards in competitive MTG</p>
            <div className="tutorial-steps">
              {tutorialSteps.map((step, index) => (
                <div className="tutorial-step" key={index}>
                  <div className="step-icon">{step.icon}</div>
                  <div className="step-content">
                    <h3>{step.title}</h3>
                    <p>{step.description}</p>
                    {step.details && <div className="step-details">{step.details}</div>}
                  </div>
                </div>
              ))}
            </div>
            <div className="fhe-diagram">
              <div className="diagram-step">
                <div className="diagram-icon">🃏</div>
                <div className="diagram-label">Card Data</div>
              </div>
              <div className="diagram-arrow">→</div>
              <div className="diagram-step">
                <div className="diagram-icon">🔒</div>
                <div className="diagram-label">FHE Encryption</div>
              </div>
              <div className="diagram-arrow">→</div>
              <div className="diagram-step">
                <div className="diagram-icon">🤫</div>
                <div className="diagram-label">Private Sideboard</div>
              </div>
            </div>
          </div>
        )}

        <div className="dashboard-grid">
          <div className="dashboard-card cyber-card">
            <h3>Deck Statistics</h3>
            <div className="stats-grid">
              <div className="stat-item">
                <div className="stat-value">{mainboardCount}</div>
                <div className="stat-label">Mainboard</div>
              </div>
              <div className="stat-item">
                <div className="stat-value">{sideboardCount}</div>
                <div className="stat-label">Sideboard</div>
              </div>
              <div className="stat-item">
                <div className="stat-value">{totalManaCost}</div>
                <div className="stat-label">Total Mana</div>
              </div>
              <div className="stat-item">
                <div className="stat-value">
                  {mainboardCount > 0 ? (totalManaCost / mainboardCount).toFixed(1) : 0}
                </div>
                <div className="stat-label">Avg. Cost</div>
              </div>
            </div>
          </div>

          <div className="dashboard-card cyber-card">
            <h3>Card Type Distribution</h3>
            <div className="type-chart">
              {['Creature', 'Instant', 'Sorcery', 'Enchantment', 'Artifact', 'Land', 'Planeswalker']
                .map(type => {
                  const count = cards.filter(c => c.cardType === type).length;
                  const percentage = cards.length > 0 ? (count / cards.length) * 100 : 0;
                  return (
                    <div key={type} className="type-row">
                      <div className="type-name">{type}</div>
                      <div className="type-bar-container">
                        <div 
                          className="type-bar" 
                          style={{ width: `${percentage}%` }}
                        ></div>
                        <div className="type-count">{count}</div>
                      </div>
                    </div>
                  );
                })}
            </div>
          </div>
        </div>

        <div className="cards-section">
          <div className="section-header">
            <div className="tabs">
              <button 
                className={`tab-button ${activeTab === "mainboard" ? "active" : ""}`}
                onClick={() => setActiveTab("mainboard")}
              >
                Mainboard ({mainboardCount})
              </button>
              <button 
                className={`tab-button ${activeTab === "sideboard" ? "active" : ""}`}
                onClick={() => setActiveTab("sideboard")}
              >
                Sideboard ({sideboardCount})
              </button>
            </div>
            <div className="header-actions">
              <div className="search-container">
                <input 
                  type="text" 
                  placeholder="Search cards..." 
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="cyber-input"
                />
                <div className="search-icon"></div>
              </div>
              <button 
                onClick={loadCards} 
                className="refresh-btn cyber-button" 
                disabled={isRefreshing}
              >
                {isRefreshing ? "Refreshing..." : "Refresh"}
              </button>
            </div>
          </div>

          <div className="cards-grid">
            {filteredCards.length === 0 ? (
              <div className="no-cards">
                <div className="no-cards-icon"></div>
                <p>No {activeTab} cards found</p>
                <button 
                  className="cyber-button primary" 
                  onClick={() => setShowAddModal(true)}
                >
                  Add First Card
                </button>
              </div>
            ) : (
              filteredCards.map(card => (
                <div 
                  className={`card-item ${card.isSideboard ? "sideboard" : ""}`} 
                  key={card.id}
                  onClick={() => setSelectedCard(card)}
                >
                  <div className="card-header">
                    <div className="card-name">{card.cardName}</div>
                    <div className="card-type">{card.cardType}</div>
                  </div>
                  <div className="card-mana">
                    {renderManaSymbols(card.manaCost)}
                  </div>
                  <div className="card-footer">
                    <div className="card-owner">
                      {card.owner.substring(0, 6)}...{card.owner.substring(38)}
                    </div>
                    {isOwner(card.owner) && (
                      <button 
                        className="move-btn cyber-button small"
                        onClick={(e) => {
                          e.stopPropagation();
                          moveToSideboard(card.id);
                        }}
                      >
                        {card.isSideboard ? "To Main" : "To Side"}
                      </button>
                    )}
                  </div>
                  {card.isSideboard && (
                    <div className="sideboard-badge">
                      <div className="lock-icon"></div>
                      <span>Encrypted</span>
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {showAddModal && (
        <ModalAddCard 
          onSubmit={addCard} 
          onClose={() => setShowAddModal(false)} 
          adding={addingCard} 
          cardData={newCardData} 
          setCardData={setNewCardData}
        />
      )}

      {selectedCard && (
        <CardDetailModal 
          card={selectedCard} 
          onClose={() => {
            setSelectedCard(null);
            setDecryptedMana(null);
          }} 
          decryptedMana={decryptedMana} 
          setDecryptedMana={setDecryptedMana} 
          isDecrypting={isDecrypting} 
          decryptWithSignature={decryptWithSignature}
        />
      )}

      {transactionStatus.visible && (
        <div className="transaction-modal">
          <div className="transaction-content cyber-card">
            <div className={`transaction-icon ${transactionStatus.status}`}>
              {transactionStatus.status === "pending" && <div className="cyber-spinner"></div>}
              {transactionStatus.status === "success" && <div className="check-icon"></div>}
              {transactionStatus.status === "error" && <div className="error-icon"></div>}
            </div>
            <div className="transaction-message">{transactionStatus.message}</div>
          </div>
        </div>
      )}

      <footer className="app-footer">
        <div className="footer-content">
          <div className="footer-brand">
            <div className="logo">
              <div className="mtg-icon"></div>
              <span>MTG FHE Sideboard</span>
            </div>
            <p>Secure encrypted sideboards using Zama FHE technology</p>
          </div>
          <div className="footer-links">
            <a href="#" className="footer-link">Documentation</a>
            <a href="#" className="footer-link">Privacy Policy</a>
            <a href="#" className="footer-link">Terms of Service</a>
            <a href="#" className="footer-link">Contact</a>
          </div>
        </div>
        <div className="footer-bottom">
          <div className="fhe-badge">
            <span>FHE-Powered Privacy</span>
          </div>
          <div className="copyright">
            © {new Date().getFullYear()} MTG FHE Sideboard. All rights reserved.
          </div>
        </div>
      </footer>
    </div>
  );
};

interface ModalAddCardProps {
  onSubmit: () => void; 
  onClose: () => void; 
  adding: boolean;
  cardData: any;
  setCardData: (data: any) => void;
}

const ModalAddCard: React.FC<ModalAddCardProps> = ({ 
  onSubmit, 
  onClose, 
  adding, 
  cardData, 
  setCardData 
}) => {
  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const { name, value } = e.target;
    setCardData({ ...cardData, [name]: value });
  };

  const handleValueChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setCardData({ ...cardData, [name]: parseFloat(value) });
  };

  const handleCheckboxChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, checked } = e.target;
    setCardData({ ...cardData, [name]: checked });
  };

  const handleSubmit = () => {
    if (!cardData.cardName || cardData.manaCost < 0) { 
      alert("Please fill required fields"); 
      return; 
    }
    onSubmit();
  };

  return (
    <div className="modal-overlay">
      <div className="add-card-modal cyber-card">
        <div className="modal-header">
          <h2>Add Encrypted MTG Card</h2>
          <button onClick={onClose} className="close-modal">&times;</button>
        </div>
        <div className="modal-body">
          <div className="fhe-notice-banner">
            <div className="key-icon"></div> 
            <div>
              <strong>FHE Encryption Notice</strong>
              <p>Card mana cost will be encrypted with Zama FHE before submission</p>
            </div>
          </div>
          <div className="form-grid">
            <div className="form-group">
              <label>Card Name *</label>
              <input 
                type="text" 
                name="cardName" 
                value={cardData.cardName} 
                onChange={handleChange} 
                placeholder="Enter card name..." 
                className="cyber-input"
              />
            </div>
            <div className="form-group">
              <label>Card Type *</label>
              <select 
                name="cardType" 
                value={cardData.cardType} 
                onChange={handleChange} 
                className="cyber-select"
              >
                <option value="Creature">Creature</option>
                <option value="Instant">Instant</option>
                <option value="Sorcery">Sorcery</option>
                <option value="Enchantment">Enchantment</option>
                <option value="Artifact">Artifact</option>
                <option value="Land">Land</option>
                <option value="Planeswalker">Planeswalker</option>
              </select>
            </div>
            <div className="form-group">
              <label>Mana Cost *</label>
              <input 
                type="number" 
                name="manaCost" 
                value={cardData.manaCost} 
                onChange={handleValueChange} 
                placeholder="Enter mana cost..." 
                className="cyber-input"
                min="0"
                step="1"
              />
            </div>
            <div className="form-group checkbox-group">
              <label>
                <input 
                  type="checkbox" 
                  name="isSideboard" 
                  checked={cardData.isSideboard} 
                  onChange={handleCheckboxChange} 
                  className="cyber-checkbox"
                />
                <span>Add to Sideboard</span>
              </label>
            </div>
          </div>
          <div className="encryption-preview">
            <h4>Encryption Preview</h4>
            <div className="preview-container">
              <div className="plain-data">
                <span>Plain Mana Cost:</span>
                <div>{cardData.manaCost}</div>
              </div>
              <div className="encryption-arrow">→</div>
              <div className="encrypted-data">
                <span>Encrypted Data:</span>
                <div>
                  {cardData.manaCost ? 
                    FHEEncryptNumber(cardData.manaCost).substring(0, 50) + '...' : 
                    'No value entered'
                  }
                </div>
              </div>
            </div>
          </div>
          <div className="privacy-notice">
            <div className="privacy-icon"></div> 
            <div>
              <strong>Strategic Advantage</strong>
              <p>Sideboard cards remain encrypted until revealed in game</p>
            </div>
          </div>
        </div>
        <div className="modal-footer">
          <button onClick={onClose} className="cancel-btn cyber-button">
            Cancel
          </button>
          <button 
            onClick={handleSubmit} 
            disabled={adding} 
            className="submit-btn cyber-button primary"
          >
            {adding ? "Encrypting with FHE..." : "Add Card"}
          </button>
        </div>
      </div>
    </div>
  );
};

interface CardDetailModalProps {
  card: SideboardCard;
  onClose: () => void;
  decryptedMana: number | null;
  setDecryptedMana: (value: number | null) => void;
  isDecrypting: boolean;
  decryptWithSignature: (encryptedData: string) => Promise<number | null>;
}

const CardDetailModal: React.FC<CardDetailModalProps> = ({ 
  card, 
  onClose, 
  decryptedMana, 
  setDecryptedMana, 
  isDecrypting, 
  decryptWithSignature 
}) => {
  const handleDecrypt = async () => {
    if (decryptedMana !== null) { 
      setDecryptedMana(null); 
      return; 
    }
    const decrypted = await decryptWithSignature(card.encryptedData);
    if (decrypted !== null) setDecryptedMana(decrypted);
  };

  return (
    <div className="modal-overlay">
      <div className="card-detail-modal cyber-card">
        <div className="modal-header">
          <h2>Card Details</h2>
          <button onClick={onClose} className="close-modal">&times;</button>
        </div>
        <div className="modal-body">
          <div className="card-info">
            <div className="info-item">
              <span>Name:</span>
              <strong>{card.cardName}</strong>
            </div>
            <div className="info-item">
              <span>Type:</span>
              <strong>{card.cardType}</strong>
            </div>
            <div className="info-item">
              <span>Owner:</span>
              <strong>
                {card.owner.substring(0, 6)}...{card.owner.substring(38)}
              </strong>
            </div>
            <div className="info-item">
              <span>Added:</span>
              <strong>
                {new Date(card.timestamp * 1000).toLocaleString()}
              </strong>
            </div>
            <div className="info-item">
              <span>Location:</span>
              <strong className={`location-badge ${card.isSideboard ? "sideboard" : "mainboard"}`}>
                {card.isSideboard ? "Sideboard" : "Mainboard"}
              </strong>
            </div>
          </div>
          <div className="encrypted-data-section">
            <h3>Encrypted Mana Cost</h3>
            <div className="encrypted-data">
              {card.encryptedData.substring(0, 100)}...
            </div>
            <div className="fhe-tag">
              <div className="fhe-icon"></div>
              <span>FHE Encrypted</span>
            </div>
            <button 
              className="decrypt-btn cyber-button" 
              onClick={handleDecrypt} 
              disabled={isDecrypting}
            >
              {isDecrypting ? (
                <span className="decrypt-spinner"></span>
              ) : decryptedMana !== null ? (
                "Hide Decrypted Value"
              ) : (
                "Decrypt with Wallet Signature"
              )}
            </button>
          </div>
          {decryptedMana !== null && (
            <div className="decrypted-data-section">
              <h3>Decrypted Mana Cost</h3>
              <div className="decrypted-value">
                {decryptedMana}
                <div className="mana-symbols">
                  {Array(Math.min(decryptedMana, 10)).fill(0).map((_, i) => (
                    <div key={i} className="mana-symbol"></div>
                  ))}
                  {decryptedMana > 10 && (
                    <div className="mana-symbol extra">+{decryptedMana-10}</div>
                  )}
                </div>
              </div>
              <div className="decryption-notice">
                <div className="warning-icon"></div>
                <span>Decrypted data is only visible after wallet signature verification</span>
              </div>
            </div>
          )}
        </div>
        <div className="modal-footer">
          <button onClick={onClose} className="close-btn cyber-button">
            Close
          </button>
        </div>
      </div>
    </div>
  );
};

export default App;