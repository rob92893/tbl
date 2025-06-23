import React, { useState, useEffect, useCallback, useRef } from 'react';
import { initializeApp } from 'firebase/app';
import { getFirestore, doc, setDoc, getDoc, onSnapshot, collection, writeBatch } from 'firebase/firestore';
import { getAuth, signInAnonymously, onAuthStateChanged, signInWithCustomToken } from 'firebase/auth';


// --- Helper Functions & Constants ---
const TEAMS = [
    { id: 'T1', name: 'Metro City Meteors', logo: '☄️' },
    { id: 'T2', name: 'Coastal Sharks', logo: '🦈' },
    { id: 'T3', name: 'Red Mountain Rovers', logo: '🌄' },
    { id: 'T4', name: 'Northern Pikes', logo: '🐟' },
    { id: 'T5', name: 'Golden Griffins', logo: '🦅' }
];
const POSITIONS = ['P', 'C', '1B', '2B', '3B', 'SS', 'LF', 'CF', 'RF'];
const REGULAR_SEASON_MAX_INNINGS = 6; // Games are 6 innings in the regular season

// --- Firebase Configuration ---
const firebaseConfig = typeof __firebase_config !== 'undefined' ? JSON.parse(__firebase_config) : {};
const appId = typeof __app_id !== 'undefined' ? __app_id : 'default-baseball-gm';

// --- Utility Functions for Player Ratings ---

/**
 * Generates a random number following a normal distribution using the Box-Muller transform.
 * @param {number} mean - The mean of the distribution.
 * @param {number} stdDev - The standard deviation of the distribution.
 * @returns {number} A random number from the normal distribution.
 */
const randomNormal = (mean, stdDev) => {
    let u = 0, v = 0;
    while (u === 0) u = Math.random(); // Converting [0,1) to (0,1)
    while (v === 0) v = Math.random();
    let z = Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
    return mean + z * stdDev;
};

/**
 * Generates initial random ratings for a new player.
 * Ratings are on a 30-99 scale with a mean of 75 and stdDev of 10.
 * If a position does not use a certain stat, it is set to 30.
 * @param {boolean} isPitcher - True if the player is a pitcher.
 * @returns {object} An object containing all player ratings.
 */
const generateRandomRatings = (isPitcher) => {
    const clampRating = (value) => Math.min(99, Math.max(30, Math.round(value)));
    const generateStat = () => clampRating(randomNormal(75, 10));

    const ratings = {
        potential: generateStat(),
        injury: generateStat(), // Lower is better for injury, but the scale remains 30-99
    };

    let handednessResult;
    const randomHandednessRoll = Math.random();

    if (isPitcher) {
        ratings.accuracy = generateStat();
        ratings.heat = generateStat();
        ratings.movement = generateStat();
        // Set batting specific ratings to a low base for pitchers
        ratings.contact = 30;
        ratings.power = 30;
        ratings.eye = 30;
        ratings.speed = generateStat(); // Pitchers still have speed for fielding/running
        ratings.fielding = generateStat(); // Pitchers can have varied fielding ratings
        
        // Pitcher handedness: 75% Right, 25% Left
        if (randomHandednessRoll < 0.75) {
            handednessResult = 'R';
        } else {
            handednessResult = 'L';
        }

    } else {
        ratings.contact = generateStat();
        ratings.power = generateStat();
        ratings.eye = generateStat();
        ratings.speed = generateStat();
        ratings.fielding = generateStat();
        // Set pitching specific ratings to a low base for fielders
        ratings.accuracy = 30;
        ratings.heat = 30;
        ratings.movement = 30;
        
        // Batter handedness: 65% Right, 25% Left, 10% Switch
        if (randomHandednessRoll < 0.65) {
            handednessResult = 'R';
        } else if (randomHandednessRoll < 0.65 + 0.25) { // 0.65 + 0.25 = 0.90
            handednessResult = 'L';
        } else { // Remaining 10%
            handednessResult = 'S';
        }
    }
    
    return { ...ratings, handedness: handednessResult };
};

/**
 * Calculates an overall offensive rating for a batter (0-100).
 * @param {object} playerRatings - The player's ratings object.
 * @returns {number} The calculated overall offensive rating.
 */
const calculateOverallBatterRating = (playerRatings) => {
    // Weighted average of Contact, Power, Eye
    return (playerRatings.contact * 0.4 + playerRatings.power * 0.3 + playerRatings.eye * 0.3);
};

/**
 * Calculates an overall defensive rating for a pitcher (0-100).
 * Lower is better for pitchers, so we'll invert the scale for sorting.
 * @param {object} playerRatings - The player's ratings object.
 * @returns {number} The calculated overall pitching rating (lower is better).
 */
const calculateOverallPitcherRating = (playerRatings) => {
    // Weighted average of Accuracy, Heat, Movement
    return (playerRatings.accuracy * 0.4 + playerRatings.heat * 0.3 + playerRatings.movement * 0.3);
};

/**
 * Generates a random player name.
 * @returns {string} A random player name.
 */
function generatePlayerName() {
    const first = ["Jake", "Mike", "Chris", "Matt", "Alex", "David", "Juan", "Jose", "Ken", "Ryu", "Bob", "Steve", "Tony", "Peter", "Leo", "Sam", "Ben", "Charlie", "Daniel", "Ethan", "Frank", "George", "Henry", "Isaac", "Jack"];
    const last = ["Smith", "Jones", "Miller", "Garcia", "Rodriguez", "Sato", "Suzuki", "Tanaka", "Kim", "Lee", "Stark", "Parker", "Banner", "Williams", "Brown", "Davis", "Wilson", "Moore", "Taylor", "Anderson", "Thomas", "Jackson", "White", "Harris"];
    return `${first[Math.floor(Math.random() * first.length)]} ${last[Math.floor(Math.random() * last.length)]}`;
}

/**
 * Generates a round-robin style schedule for the given teams.
 * Each team plays every other team a set number of times (gamesPerMatchup).
 * @param {Array<string>} teamIds - An array of team IDs.
 * @returns {Array<object>} A shuffled array of game objects ({ home: teamId, away: teamId }).
 */
function generateSchedule(teamIds) {
    const schedule = [];
    const gamesPerMatchup = 4; // Each pair of teams plays 4 games (2 home, 2 away) for a total of 16 games per season
    
    if (teamIds.length < 2) return [];

    // Create all matchups
    for(let i = 0; i < teamIds.length; i++) {
        for(let j = i + 1; j < teamIds.length; j++) {
            // Add games in both home and away configurations
            for(let k = 0; k < gamesPerMatchup / 2; k++) { // 2 home, 2 away for 4 games total
                schedule.push({ home: teamIds[i], away: teamIds[j] });
                schedule.push({ home: teamIds[j], away: teamIds[i] });
            }
        }
    }
    // Simple shuffle to randomize game order
    return schedule.sort(() => Math.random() - 0.5);
}


// --- UI Components ---

/**
 * Displays a full-screen loading message.
 */
function LoadingScreen() {
    return (
        <div className="flex justify-center items-center min-h-screen bg-gray-900 text-white">
            <div className="text-xl font-semibold">Loading your franchise...</div>
        </div>
    );
}

/**
 * Displays a full-screen error message.
 */
function ErrorScreen({ message }) {
    return (
        <div className="flex justify-center items-center min-h-screen bg-red-800 text-white p-4 text-center">
            <div className="text-xl font-semibold">Error: {message}</div>
        </div>
    );
}

/**
 * Modal component for user confirmations.
 */
function ConfirmationModal({ message, onConfirm, onCancel }) {
    return (
        <div className="fixed inset-0 bg-black bg-opacity-75 flex justify-center items-center p-4 z-50">
            <div className="bg-gray-800 rounded-lg p-6 shadow-xl max-w-sm w-full border border-gray-700">
                <p className="text-white text-lg mb-6 text-center">{message}</p>
                <div className="flex justify-around gap-4">
                    <button
                        onClick={onConfirm}
                        className="flex-1 bg-red-600 hover:bg-red-700 text-white font-bold py-2 px-4 rounded-lg transition duration-300"
                    >
                        Confirm
                    </button>
                    <button
                        onClick={onCancel}
                        className="flex-1 bg-gray-600 hover:bg-gray-700 text-white font-bold py-2 px-4 rounded-lg transition duration-300"
                    >
                        Cancel
                    </button>
                </div>
            </div>
        </div>
    );
}


/**
 * Allows the user to select their team to start a new game.
 */
function TeamSelectionScreen({ onSelect }) {
    return (
        <div className="min-h-screen bg-gray-800 flex flex-col justify-center items-center p-4">
            <h1 className="text-4xl font-bold text-white mb-2">Welcome to Baseball GM Sim</h1>
            <p className="text-gray-300 mb-8">Choose your team to begin your legacy.</p>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 w-full max-w-4xl">
                {TEAMS.map(team => (
                    <div key={team.id} onClick={() => onSelect(team.id)} className="bg-gray-700 rounded-lg p-6 text-center cursor-pointer hover:bg-blue-600 hover:shadow-lg transition duration-300 transform hover:-translate-y-1">
                        <span className="text-5xl">{team.logo}</span>
                        <h2 className="2xl font-semibold mt-2">{team.name}</h2>
                    </div>
                ))}
            </div>
        </div>
    );
}

/**
 * Header component displaying team info, year, and navigation.
 */
function Header({ team, year, onSimulate, onNav, isSeasonOver, isPostseason, championshipWinnerName }) {
    return (
        <header className="bg-gray-800 rounded-lg p-4 shadow-lg">
            <div className="flex flex-wrap justify-between items-center gap-4">
                <div>
                    <h1 className="text-3xl font-bold flex items-center gap-3">{team.logo} {team.name}</h1>
                    <p className="text-blue-300 text-xl">Year: {year}</p>
                    {championshipWinnerName && <p className="text-yellow-400 text-xl font-semibold">🏆 {championshipWinnerName} are Champions!</p>}
                </div>
                <button 
                    onClick={onSimulate} 
                    className="bg-green-600 hover:bg-green-700 text-white font-bold py-2 px-6 rounded-lg transition duration-300 shadow-md hover:shadow-lg"
                >
                    {isSeasonOver ? 
                        (isPostseason ? 'Simulate Playoff Game' : 'Start Postseason') : 
                        'Simulate Next Game'
                    }
                </button>
            </div>
            <nav className="mt-4 grid grid-cols-2 sm:grid-cols-4 gap-2">
                <button onClick={() => onNav('dashboard')} className="text-center bg-gray-700 hover:bg-blue-600 py-2 px-2 rounded-md transition duration-200">Dashboard</button>
                <button onClick={() => onNav('roster')} className="text-center bg-gray-700 hover:bg-blue-600 py-2 px-2 rounded-md transition duration-200">Roster</button>
                <button onClick={() => onNav('schedule')} className="text-center bg-gray-700 hover:bg-blue-600 py-2 px-2 rounded-md transition duration-200">Schedule</button>
                <button onClick={() => onNav('standings')} className="text-center bg-gray-700 hover:bg-blue-600 py-2 px-2 rounded-md transition duration-200">Standings</button>
            </nav>
        </header>
    );
}

/**
 * Displays the main dashboard view for the user's team.
 */
function DashboardView({ team, gameState, lastGameResult }) {
    const standings = gameState.standings.find(s => s.teamId === team.id) || { wins: 0, losses: 0 };
    const allPlayers = Object.values(gameState.players).filter(p => p.teamId === team.id);

    // Find top hitter (min 10 at-bats for qualification)
    const topHitter = allPlayers
        .filter(p => p.position !== 'P' && p.stats.atBats > 10)
        .sort((a, b) => b.stats.avg - a.stats.avg)[0];

    // Find top pitcher (lowest BAA, min 10 batters faced for qualification)
    const topPitcher = allPlayers
        .filter(p => p.position === 'P' && p.stats.atBatsFaced > 10) // Use atBatsFaced for pitchers
        .sort((a, b) => a.stats.baa - b.stats.baa)[0]; 

    return (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="bg-gray-800 p-4 rounded-lg shadow-md">
                <h2 className="text-2xl font-bold border-b border-gray-700 pb-2 mb-2">Team Info</h2>
                <p className="text-lg">Record: <span className="font-mono text-green-400">{standings.wins} - {standings.losses}</span></p>
                <p className="text-lg">Win %: <span className="font-mono text-green-400">{((standings.wins / (standings.wins + standings.losses)) || 0).toFixed(3)}</span></p>
                {gameState.isPostseason && gameState.postseasonSeries.length > 0 && (
                    <div className="mt-4">
                        <h3 className="text-xl font-semibold border-b border-gray-700 pb-1 mb-2">Championship Series</h3>
                        <p className="text-lg">
                            {gameState.teams[gameState.postseasonSeries[0].home].logo} {gameState.teams[gameState.postseasonSeries[0].home].name}: {gameState.postseasonSeriesScores[gameState.postseasonSeries[0].home]}
                        </p>
                        <p className="text-lg">
                            {gameState.teams[gameState.postseasonSeries[0].away].logo} {gameState.teams[gameState.postseasonSeries[0].away].name}: {gameState.postseasonSeriesScores[gameState.postseasonSeries[0].away]}
                        </p>
                        <p className="text-lg text-yellow-300 mt-2">Game {gameState.postseasonGameIndex + 1} of 3</p>
                    </div>
                )}
            </div>
            <div className="bg-gray-800 p-4 rounded-lg shadow-md">
                <h2 className="text-2xl font-bold border-b border-gray-700 pb-2 mb-2">Top Performers</h2>
                {topHitter ? <p>Hitter: {topHitter.name} (AVG: {topHitter.stats.avg.toFixed(3)})</p> : <p>No qualified hitters yet.</p>}
                {topPitcher ? <p>Pitcher: {topPitcher.name} (BAA: {topPitcher.stats.baa.toFixed(3)})</p> : <p>No qualified pitchers yet.</p>}
            </div>
            <div className="bg-gray-800 p-4 rounded-lg md:col-span-2 shadow-md">
                <h2 className="text-2xl font-bold border-b border-gray-700 pb-2 mb-2">Next Game</h2>
                {gameState.gameIndex < gameState.schedule.length ? 
                    <p className="text-xl text-center">
                        {gameState.teams[gameState.schedule[gameState.gameIndex].away].logo} {gameState.teams[gameState.schedule[gameState.gameIndex].away].name} 
                        <span className="text-gray-400 mx-2">vs</span> 
                        {gameState.teams[gameState.schedule[gameState.gameIndex].home].logo} {gameState.teams[gameState.schedule[gameState.gameIndex].home].name}
                    </p> :
                    (gameState.isPostseason && gameState.postseasonGameIndex < gameState.postseasonSeries.length ?
                        <p className="text-xl text-center text-yellow-400">
                             {gameState.teams[gameState.postseasonSeries[gameState.postseasonGameIndex].away].logo} {gameState.teams[gameState.postseasonSeries[gameState.postseasonGameIndex].away].name} 
                            <span className="text-gray-400 mx-2">vs</span> 
                            {gameState.teams[gameState.postseasonSeries[gameState.postseasonGameIndex].home].logo} {gameState.teams[gameState.postseasonSeries[gameState.postseasonGameIndex].home].name}
                            <span className="block text-sm text-gray-500">(Championship Game {gameState.postseasonGameIndex + 1})</span>
                        </p>
                        :
                        <p className="text-xl text-center text-yellow-400">Offseason</p>
                    )
                }
            </div>
            {lastGameResult && (
                <div className="bg-gray-800 p-4 rounded-lg md:col-span-2 shadow-md">
                    <h2 className="text-2xl font-bold border-b border-gray-700 pb-2 mb-2">Last Game Result</h2>
                    <p className="text-xl text-center">
                        {lastGameResult.awayTeamId ? gameState.teams[lastGameResult.awayTeamId].logo : ''} {lastGameResult.awayTeamId ? gameState.teams[lastGameResult.awayTeamId].name : 'Away Team'}: {lastGameResult.awayScore} 
                        <span className="mx-2">-</span> 
                        {lastGameResult.homeScore} {lastGameResult.homeTeamId ? gameState.teams[lastGameResult.homeTeamId].name : 'Home Team'} {lastGameResult.homeTeamId ? gameState.teams[lastGameResult.homeTeamId].logo : ''}
                    </p>
                    <p className="text-center text-green-400">{lastGameResult.winner ? gameState.teams[lastGameResult.winner].name : 'Unknown Team'} wins!</p>
                </div>
            )}
        </div>
    );
}

/**
 * Displays the team roster and allows switching to the lineup editor.
 */
function RosterView({ team, players, updatePlayersBulk }) {
    const [subView, setSubView] = useState('list'); // 'list' or 'lineup'

    const teamPlayers = Object.values(players).filter(p => p.teamId === team.id).sort((a, b) => a.name.localeCompare(b.name));

    return (
        <div className="bg-gray-800 p-4 rounded-lg shadow-md">
            <div className="flex justify-center mb-4 bg-gray-700 rounded-md p-1">
                <button
                    onClick={() => setSubView('list')}
                    className={`flex-1 py-2 px-4 rounded-md transition duration-200 ${subView === 'list' ? 'bg-blue-600 text-white' : 'hover:bg-gray-600'}`}
                >
                    Full Roster
                </button>
                <button
                    onClick={() => setSubView('lineup')}
                    className={`flex-1 py-2 px-4 rounded-md transition duration-200 ${subView === 'lineup' ? 'bg-blue-600 text-white' : 'hover:bg-gray-600'}`}
                >
                    Set Lineup
                </button>
            </div>

            {subView === 'list' && (
                <>
                    <h2 className="text-2xl font-bold mb-4">Team Roster</h2>
                    <div className="overflow-x-auto">
                        <table className="w-full text-left">
                            <thead className="bg-gray-700"><tr>
                                    <th className="p-3">Name</th>
                                    <th className="p-3">Pos</th>
                                    <th className="p-3 text-center">Age</th>
                                    <th className="p-3 text-right">Overall</th>
                                    <th className="p-3 text-right">Potential</th>
                                    <th className="p-3 text-right">Injury</th>
                                    <th className="p-3 text-right">Batting Avg</th>
                                    <th className="p-3 text-right">HR</th>
                                    <th className="p-3 text-right">RBI</th>
                                    <th className="p-3 text-right">BB</th>
                                    <th className="p-3 text-right">SO</th>
                                    <th className="p-3 text-right">Pitching IP</th>
                                    <th className="p-3 text-right">Pitching BAA</th>
                                    <th className="p-3 text-right">K Allowed</th>
                                    <th className="p-3 text-right">Errors</th> 
                                    <th className="p-3 text-right">Golden Glove Plays</th> {/* Renamed */}
                                    <th className="p-3 text-right">Plays Attempted</th> {/* New */}
                                    <th className="p-3 text-right">Bases Robbed</th> {/* New */}
                                </tr></thead>
                            <tbody>{teamPlayers.sort((a,b) => (a.position > b.position) ? 1 : (a.position < b.position) ? -1 : a.name.localeCompare(b.name)).map(player => (
                                    <tr key={player.id} className="border-b border-gray-700 hover:bg-gray-700/50">
                                        <td className="p-3">{player.name}</td>
                                        <td className="p-3">{player.position}</td>
                                        <td className="p-3 text-center">{player.age}</td>
                                        <td className="p-3 text-right font-mono">
                                            {player.position === 'P' ? calculateOverallPitcherRating(player.ratings).toFixed(0) : calculateOverallBatterRating(player.ratings).toFixed(0)}
                                        </td>
                                        <td className="p-3 text-right font-mono">{player.ratings.potential.toFixed(0)}</td>
                                        <td className="p-3 text-right font-mono">{player.ratings.injury.toFixed(0)}</td>
                                        <td className="p-3 text-right font-mono">{player.stats.avg.toFixed(3)}</td>
                                        <td className="p-3 text-right font-mono">{player.stats.homeRuns}</td>
                                        <td className="p-3 text-right font-mono">{player.stats.runsBattedIn}</td>
                                        <td className="p-3 text-right font-mono">{player.stats.walks}</td>
                                        <td className="p-3 text-right font-mono">{player.stats.strikeOuts}</td>
                                        <td className="p-3 text-right font-mono">{player.stats.inningsPitched}</td>
                                        <td className="p-3 text-right font-mono">{player.stats.baa.toFixed(3)}</td>
                                        <td className="p-3 text-right font-mono">{player.stats.strikeOutsAllowed}</td>
                                        <td className="p-3 text-right font-mono">{player.stats.errors}</td> 
                                        <td className="p-3 text-right font-mono">{player.stats.goldenGlovePlays}</td> {/* Renamed */}
                                        <td className="p-3 text-right font-mono">{player.stats.playsAttempted}</td> {/* New */}
                                        <td className="p-3 text-right font-mono">{player.stats.basesRobbed}</td> {/* New */}
                                    </tr>
                                ))}</tbody>
                        </table>
                    </div>
                </>
            )}

            {subView === 'lineup' && (
                <LineupEditor teamPlayers={teamPlayers} updatePlayersBulk={updatePlayersBulk} />
            )}
        </div>
    );
}

/**
 * Component for editing the team's batting lineup and starting pitcher.
 */
function LineupEditor({ teamPlayers, updatePlayersBulk }) {
    // Separate state for batters and pitcher being edited
    const [currentBattersLineup, setCurrentBattersLineup] = useState(Array(9).fill(null));
    const [currentStartingPitcher, setCurrentStartingPitcher] = useState(null);

    // Filter available players for dropdowns, sorted by overall rating
    // Batters should only be non-pitchers
    const availableBatters = teamPlayers.filter(p => p.position !== 'P').sort((a, b) => calculateOverallBatterRating(b.ratings) - calculateOverallBatterRating(a.ratings));
    // Pitchers should only be pitchers
    const availablePitchers = teamPlayers.filter(p => p.position === 'P').sort((a, b) => calculateOverallPitcherRating(a.ratings) - calculateOverallPitcherRating(b.ratings));

    // Initialize lineup from current player data on mount or when teamPlayers change
    useEffect(() => {
        const initialLineup = Array(9).fill(null);
        let initialSP = null;

        teamPlayers.forEach(player => {
            if (player.lineupPosition >= 0 && player.lineupPosition < 9) {
                initialLineup[player.lineupPosition] = player.id;
            }
            if (player.isStartingPitcher) {
                initialSP = player.id;
            }
        });
        setCurrentBattersLineup(initialLineup);
        setCurrentStartingPitcher(initialSP);
    }, [teamPlayers]);

    // Handle change in batting lineup slot
    const handleBatterChange = (index, playerId) => {
        setCurrentBattersLineup(prev => {
            const newLineup = [...prev];
            // Ensure no player is selected twice in the batting lineup
            if (playerId && newLineup.includes(playerId)) {
                // If the player is already in the lineup, swap them
                const oldIndex = newLineup.indexOf(playerId);
                if (oldIndex !== -1) {
                    newLineup[oldIndex] = null; // Clear old position
                }
            }
            newLineup[index] = playerId;
            return newLineup;
        });
    };

    // Handle change in starting pitcher
    const handlePitcherChange = (playerId) => {
        setCurrentStartingPitcher(playerId);
    };

    // Save the new lineup to Firestore
    const handleSaveLineup = async () => {
        const updates = {};

        // First, reset all player lineup positions and isStartingPitcher flags for this team
        teamPlayers.forEach(player => {
            updates[player.id] = { lineupPosition: -1, isStartingPitcher: false };
        });

        // Set new batting lineup positions
        currentBattersLineup.forEach((playerId, index) => {
            if (playerId) {
                updates[playerId] = { ...(updates[playerId] || {}), lineupPosition: index };
            }
            // Ensure any nulls (empty slots) also clear the lineupPosition for that player if they were previously there
            else {
                const playerToClear = teamPlayers.find(p => p.lineupPosition === index);
                if (playerToClear) {
                    updates[playerToClear.id] = { ...(updates[playerToClear.id] || {}), lineupPosition: -1 };
                }
            }
        });

        // Set new starting pitcher
        if (currentStartingPitcher) {
            updates[currentStartingPitcher] = { ...(updates[currentStartingPitcher] || {}), isStartingPitcher: true };
        } else {
             // If no pitcher is selected, ensure no player is marked as SP
             const playerToClearSP = teamPlayers.find(p => p.isStartingPitcher);
             if (playerToClearSP) {
                 updates[playerToClearSP.id] = { ...(updates[playerToClearSP.id] || {}), isStartingPitcher: false };
             }
        }

        await updatePlayersBulk(updates);
    };

    return (
        <div className="bg-gray-800 p-4 rounded-lg shadow-md">
            <h2 className="text-2xl font-bold mb-4">Set Lineup</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {/* Batting Lineup */}
                <div>
                    <h3 className="text-xl font-semibold mb-2 border-b border-gray-700 pb-1">Batting Order (DH included)</h3>
                    {Array.from({ length: 9 }).map((_, index) => (
                        <div key={`batter-${index}`} className="flex items-center gap-2 mb-2">
                            <span className="font-bold w-8">{index + 1}.</span>
                            <select
                                className="flex-1 bg-gray-700 border border-gray-600 rounded-md py-2 px-3 text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                                value={currentBattersLineup[index] || ''}
                                onChange={(e) => handleBatterChange(index, e.target.value)}
                            >
                                <option value="">-- Select Batter --</option>
                                {availableBatters.map(player => (
                                    // Disable options for players already in another lineup slot
                                    <option 
                                        key={player.id} 
                                        value={player.id}
                                        disabled={currentBattersLineup.includes(player.id) && currentBattersLineup[index] !== player.id}
                                    >
                                        {player.name} (Overall: {calculateOverallBatterRating(player.ratings).toFixed(0)})
                                    </option>
                                ))}
                            </select>
                        </div>
                    ))}
                </div>

                {/* Starting Pitcher */}
                <div>
                    <h3 className="text-xl font-semibold mb-2 border-b border-gray-700 pb-1">Starting Pitcher</h3>
                    <div className="flex items-center gap-2 mb-2">
                        <span className="font-bold w-8">SP:</span>
                        <select
                            className="flex-1 bg-gray-700 border border-gray-600 rounded-md py-2 px-3 text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                            value={currentStartingPitcher || ''}
                            onChange={(e) => handlePitcherChange(e.target.value)}
                        >
                            <option value="">-- Select Pitcher --</option>
                            {availablePitchers.map(player => (
                                <option key={player.id} value={player.id}>
                                    {player.name} (Overall: {calculateOverallPitcherRating(player.ratings).toFixed(0)})
                                </option>
                            ))}
                        </select>
                    </div>
                </div>
            </div>

            <button
                onClick={handleSaveLineup}
                className="mt-6 bg-blue-600 hover:bg-blue-700 text-white font-bold py-2 px-6 rounded-lg transition duration-300 w-full"
            >
                Save Lineup
            </button>
        </div>
    );
}


/**
 * Displays the current season schedule.
 */
function ScheduleView({ schedule, gameIndex, teams }) {
    return (
        <div className="bg-gray-800 p-4 rounded-lg shadow-md">
            <h2 className="text-2xl font-bold mb-4">Season Schedule</h2>
            <div className="max-h-96 overflow-y-auto pr-2 custom-scrollbar">
                {schedule.length === 0 && <p className="text-gray-400 text-center py-4">No games scheduled yet.</p>}
                {schedule.map((game, index) => (
                    <div key={index} className={`p-3 rounded mb-2 flex justify-center items-center text-sm sm:text-base ${index < gameIndex ? 'bg-gray-900 text-gray-500' : 'bg-gray-700'}`}>
                        <span className="flex-1 text-right">{teams[game.away].logo} {teams[game.away].name}</span>
                        <span className="mx-4 text-gray-400 font-bold">vs</span>
                        <span className="flex-1 text-left">{teams[game.home].name} {teams[game.home].logo}</span>
                    </div>
                ))}
            </div>
        </div>
    );
}

/**
 * Displays the current league standings.
 */
function StandingsView({ standings, teams }) {
    return (
        <div className="bg-gray-800 p-4 rounded-lg shadow-md">
            <h2 className="text-2xl font-bold mb-4">League Standings</h2>
            <div>
                {standings.length === 0 && <p className="text-gray-400 text-center py-4">No standings data yet.</p>}
                {standings.sort((a,b) => b.wins - a.wins).map((s, index) => (
                    <div key={s.teamId} className="flex justify-between items-center p-3 rounded mb-2 bg-gray-700">
                        <span className="flex-1 font-bold text-lg flex items-center gap-3">{index + 1}. {teams[s.teamId].logo} {teams[s.teamId].name}</span>
                        <span className="w-24 text-right font-mono text-lg">{s.wins} - {s.losses}</span>
                    </div>
                ))}
            </div>
        </div>
    );
}

/**
 * Game Simulation View: Displays the visual game, score, bases, and allows stepping through at-bats.
 */
function GameSimulationView({ interactiveGameData, setInteractiveGameData, teams, players, onGameEnd, simulateAtBat, handlePreAtBatEvents, getEligibleFielders }) {
    const { 
        currentInning, currentHalfInning, homeScore, awayScore, outs, bases,
        currentBatterId, currentPitcherId, gameLog,
        homeTeamId, awayTeamId, homeLineup, awayLineup,
        playerUpdatesCache,
        homeBattingIndex, 
        awayBattingIndex, 
        isPostseason 
    } = interactiveGameData;

    const [ballAnimation, setBallAnimation] = useState({ x: 0, y: 0, isVisible: false, hitAngle: 0, hitType: 'NONE' });
    const [fielderAnimation, setFielderAnimation] = useState({ playerId: null, fromX: 0, fromY: 0, toX: 0, toY: 0, isMoving: false });
    const [currentPlayResult, setCurrentPlayResult] = useState('');
    const animationTimeoutRef = useRef(null);
    const playResultTimeoutRef = useRef(null);

    const currentBatter = players ? players[currentBatterId] : null;
    const currentPitcher = players ? players[currentPitcherId] : null;

    const currentBattingTeamId = currentHalfInning === 'top' ? awayTeamId : homeTeamId;
    const currentPitchingTeamId = currentHalfInning === 'top' ? homeTeamId : awayTeamId;

    const currentBattingTeam = teams[currentBattingTeamId];
    const currentPitchingTeam = teams[currentPitchingTeamId];

    // Image dimensions
    const IMAGE_WIDTH = 1360;
    const IMAGE_HEIGHT = 1179;

    // Provided pixel coordinates from the user
    const ORIGINAL_COORDS = {
        home: { x: 674, y: 1042 },
        first: { x: 872, y: 847 },
        second: { x: 674, y: 652 },
        third: { x: 476, y: 847 },
        pitcher: { x: 674, y: 859 },
        leftFieldCorner: { x: 39, y: 407 },
        deepCenterField: { x: 674, y: 0 }, 
        rightFieldCorner: { x: 1320, y: 396 },
    };

    // Bases for runners - these are the exact pixel coordinates of the bases on the image
    const BASE_COORDS = {
        home: { x: ORIGINAL_COORDS.home.x, y: ORIGINAL_COORDS.home.y },
        first: { x: ORIGINAL_COORDS.first.x, y: ORIGINAL_COORDS.first.y },
        second: { x: ORIGINAL_COORDS.second.x, y: ORIGINAL_COORDS.second.y },
        third: { x: ORIGINAL_COORDS.third.x, y: ORIGINAL_COORDS.third.y },
    };

    // Helper function to calculate position using trigonometry
    const calculateTrigPosition = useCallback((angleDegreesBaseball, distance, centerX, centerY) => {
        // Convert baseball angle (0-90, where 45 is CF/vertical) to standard trig angle (0 is positive X, 90 is positive Y)
        // Adjust for screen Y-axis where positive is down.
        const angleRadiansTrig = (135 - angleDegreesBaseball) * (Math.PI / 180);
        const x_offset = distance * Math.cos(angleRadiansTrig);
        const y_offset = -distance * Math.sin(angleRadiansTrig); // Negative for screen Y-axis (positive is down)
        return {
            x: centerX + x_offset,
            y: centerY + y_offset
        };
    }, []);

    // Player fielding positions - calculated using trigonometry from home plate
    const PLAYER_POSITIONS_COORDS = {
        'P': { x: ORIGINAL_COORDS.pitcher.x, y: ORIGINAL_COORDS.pitcher.y }, // Pitcher remains at fixed mound position
        'C': { x: ORIGINAL_COORDS.home.x, y: ORIGINAL_COORDS.home.y + 30 }, // Catcher remains slightly behind home plate
        
        // Infielders
        '3B': calculateTrigPosition(10.625, 220, ORIGINAL_COORDS.home.x, ORIGINAL_COORDS.home.y), // Mid-angle 10.625 deg, 220px from home
        'SS': calculateTrigPosition(31.875, 385, ORIGINAL_COORDS.home.x, ORIGINAL_COORDS.home.y), // Mid-angle 31.875 deg, 385px from home
        '2B': calculateTrigPosition(58.125, 385, ORIGINAL_COORDS.home.x, ORIGINAL_COORDS.home.y), // Mid-angle 58.125 deg, 385px from home
        '1B': calculateTrigPosition(79.375, 220, ORIGINAL_COORDS.home.x, ORIGINAL_COORDS.home.y), // Mid-angle 79.375 deg, 220px from home

        // Outfielders
        'LF': calculateTrigPosition(15, 600, ORIGINAL_COORDS.home.x, ORIGINAL_COORDS.home.y), // Mid-angle 15 deg, 600px from home
        'CF': calculateTrigPosition(45, 650, ORIGINAL_COORDS.home.x, ORIGINAL_COORDS.home.y), // Mid-angle 45 deg, 650px from home
        'RF': calculateTrigPosition(75, 600, ORIGINAL_COORDS.home.x, ORIGINAL_COORDS.home.y), // Mid-angle 75 deg, 600px from home
    };

    /**
     * Calculates the target (x, y) coordinates for a batted ball animation.
     * The `hitAngle` (0-90 where 0 is LF line, 90 is RF line) is used to interpolate
     * a vector from home plate towards the outfield boundaries.
     * The `hitType` determines how far along that vector the ball travels.
     */
    const calculateBallTarget = useCallback((homeX, homeY, angle, hitType) => {
        // Vectors from home plate to outfield corners/deep center
        const homeToLF = { x: ORIGINAL_COORDS.leftFieldCorner.x - homeX, y: ORIGINAL_COORDS.leftFieldCorner.y - homeY };
        const homeToCF = { x: ORIGINAL_COORDS.deepCenterField.x - homeX, y: ORIGINAL_COORDS.deepCenterField.y - homeY };
        const homeToRF = { x: ORIGINAL_COORDS.rightFieldCorner.x - homeX, y: ORIGINAL_COORDS.rightFieldCorner.y - homeY };

        let interpolatedX, interpolatedY;

        // Interpolate the direction vector based on the hit angle
        const normalizedAngle = angle / 90; // Normalize angle to 0-1 range
        if (normalizedAngle <= 0.5) { // Between LF and CF (0 to 45 degrees)
            const ratio = normalizedAngle / 0.5; // Scale to 0-1 for this segment
            interpolatedX = homeToLF.x + (homeToCF.x - homeToLF.x) * ratio;
            interpolatedY = homeToLF.y + (homeToCF.y - homeToLF.y) * ratio;
        } else { // Between CF and RF (45 to 90 degrees)
            const ratio = (normalizedAngle - 0.5) / 0.5; // Scale to 0-1 for this segment
            interpolatedX = homeToCF.x + (homeToRF.x - homeToCF.x) * ratio;
            interpolatedY = homeToCF.y + (homeToRF.y - homeToCF.y) * ratio;
        }

        // Calculate the magnitude of this interpolated vector (distance to the fence at this angle)
        const magnitude = Math.sqrt(interpolatedX * interpolatedX + interpolatedY * interpolatedY);

        let finalDistance;
        // Determine the actual travel distance based on hit type
        if (hitType === 'HOME_RUN') {
            finalDistance = magnitude * 1.1; // 10% beyond the fence
        } else if (['SINGLE', 'DOUBLE', 'TRIPLE', 'OUT'].includes(hitType)) {
            let hitFactor;
            switch (hitType) {
                case 'SINGLE': hitFactor = 0.4 + Math.random() * 0.2; break; // 40-60% of fence distance
                case 'DOUBLE': hitFactor = 0.6 + Math.random() * 0.2; break; // 60-80% of fence distance
                case 'TRIPLE': hitFactor = 0.8 + Math.random() * 0.2; break; // 80-100% of fence distance
                case 'OUT': hitFactor = Math.random(); break; // Can land anywhere in play
                default: hitFactor = 0.5; // Fallback
            }
            finalDistance = magnitude * hitFactor;
        } else {
            finalDistance = 0; // No movement for walks/strikeouts
        }

        // Calculate final target coordinates relative to the image's (0,0) origin
        const finalVectorX = (interpolatedX / magnitude) * finalDistance;
        const finalVectorY = (interpolatedY / magnitude) * finalDistance;

        const targetX = homeX + finalVectorX;
        const targetY = homeY + finalVectorY;

        return { x: targetX, y: targetY };
    }, [ORIGINAL_COORDS.leftFieldCorner, ORIGINAL_COORDS.deepCenterField, ORIGINAL_COORDS.rightFieldCorner]);


    /**
     * Maps player IDs to their current positions on the field (including runners).
     * @param {object} playersData - All player objects.
     * @param {object} currentHomeLineup - The home team's active lineup.
     * @param {object} currentAwayLineup - The away team's active lineup.
     * @param {Array<string|null>} currentBases - Current runners on bases (player IDs or 'GHOST_RUNNER').
     * @param {string} currentBattingTeamId - ID of the team currently batting.
     * @param {string} homeTeamId - ID of the home team.
     * @param {string} awayTeamId - ID of the away team.
     * @returns {object} A map of playerId to {x, y, label, isBatter, isPitcher, isRunner}.
     */
    const getFieldPlayerPositions = useCallback((playersData, homeLineup, awayLineup, currentBases, battingTeamId, homeTeamId, awayTeamId) => {
        const positions = {};

        // Defensive team players (pitching team)
        const pitchingTeamId = battingTeamId === awayTeamId ? homeTeamId : awayTeamId;
        const pitchingLineup = pitchingTeamId === homeTeamId ? homeLineup : awayLineup;

        Object.values(playersData).forEach(player => {
            if (player.teamId === pitchingTeamId) {
                if (player.id === pitchingLineup.pitcher?.id) {
                    positions[player.id] = { ...PLAYER_POSITIONS_COORDS['P'], label: 'P', isPitcher: true, isBatter: false, isRunner: false, name: player.name, teamLogo: teams[player.teamId].logo };
                } else if (player.position === 'C') {
                    positions[player.id] = { ...PLAYER_POSITIONS_COORDS['C'], label: 'C', isPitcher: false, isBatter: false, isRunner: false, name: player.name, teamLogo: teams[player.teamId].logo };
                } else if (PLAYER_POSITIONS_COORDS[player.position]) {
                    positions[player.id] = { ...PLAYER_POSITIONS_COORDS[player.position], label: player.position, isPitcher: false, isBatter: false, isRunner: false, name: player.name, teamLogo: teams[player.teamId].logo };
                }
            }
        });

        // Current Batter (at home plate)
        if (currentBatter) {
            positions[currentBatter.id] = { ...BASE_COORDS.home, label: 'B', isBatter: true, isPitcher: false, isRunner: false, name: currentBatter.name, teamLogo: teams[currentBatter.teamId].logo };
        }

        // Runners on bases
        if (currentBases[0]) { 
            if (currentBases[0] === 'GHOST_RUNNER') {
                positions['GHOST_RUNNER_1'] = { ...BASE_COORDS.first, label: 'GR', isRunner: true, name: 'Ghost Runner', teamLogo: '👻' };
            } else {
                const runner = playersData[currentBases[0]];
                positions[runner.id] = { ...BASE_COORDS.first, label: '1B', isRunner: true, name: runner.name, teamLogo: teams[runner.teamId].logo };
            }
        }
        if (currentBases[1]) { 
            if (currentBases[1] === 'GHOST_RUNNER') {
                positions['GHOST_RUNNER_2'] = { ...BASE_COORDS.second, label: 'GR', isRunner: true, name: 'Ghost Runner', teamLogo: '👻' };
            } else {
                const runner = playersData[currentBases[1]];
                positions[runner.id] = { ...BASE_COORDS.second, label: '2B', isRunner: true, name: runner.name, teamLogo: teams[runner.teamId].logo };
            }
        }
        if (currentBases[2]) { 
            if (currentBases[2] === 'GHOST_RUNNER') {
                positions['GHOST_RUNNER_3'] = { ...BASE_COORDS.third, label: 'GR', isRunner: true, name: 'Ghost Runner', teamLogo: '👻' };
            } else {
                const runner = playersData[currentBases[2]];
                positions[runner.id] = { ...BASE_COORDS.third, label: '3B', isRunner: true, name: runner.name, teamLogo: teams[runner.teamId].logo };
            }
        }

        return positions;
    }, [currentBatter, homeTeamId, awayTeamId, teams, players, PLAYER_POSITIONS_COORDS, BASE_COORDS]); 

    const fieldPlayerPositions = getFieldPlayerPositions(players, homeLineup, awayLineup, bases, currentBattingTeamId, homeTeamId, awayTeamId);

    const isGameOver = (interactiveGameData.currentInning >= REGULAR_SEASON_MAX_INNINGS && interactiveGameData.outs >=3 && interactiveGameData.currentHalfInning === 'bottom' && interactiveGameData.homeScore !== interactiveGameData.awayScore) ||
                       (interactiveGameData.currentInning > REGULAR_SEASON_MAX_INNINGS && interactiveGameData.outs >=3 && interactiveGameData.currentHalfInning === 'bottom' && interactiveGameData.homeScore !== interactiveGameData.awayScore);

    const updatePlayerCache = useCallback((playerId, updates) => {
        setInteractiveGameData(prev => {
            const newCache = { ...prev.playerUpdatesCache };
            newCache[playerId] = {
                ...(newCache[playerId] || {
                    playerId: playerId, 
                    atBats: 0, hits: 0, homeRuns: 0, walks: 0, strikeOuts: 0, runsScored: 0, runsBattedIn: 0, 
                    atBatsFaced: 0, strikeOutsAllowed: 0, walksAllowed: 0, hitsAllowed: 0, homeRunsAllowed: 0, 
                    inningsPitched: 0, saves: 0, 
                    errors: 0, goldenGlovePlays: 0, playsAttempted: 0, basesRobbed: 0 
                }),
                ...updates
            };
            return { ...prev, playerUpdatesCache: newCache };
        });
    }, [setInteractiveGameData]);

    const runPlay = useCallback(() => {
        setBallAnimation({ x: 0, y: 0, isVisible: false, hitAngle: 0, hitType: 'NONE' });
        setFielderAnimation({ playerId: null, fromX: 0, fromY: 0, toX: 0, toY: 0, isMoving: false }); 
        setCurrentPlayResult('');

        clearTimeout(animationTimeoutRef.current);
        clearTimeout(playResultTimeoutRef.current);

        let newOuts = interactiveGameData.outs;
        let newBases = [...interactiveGameData.bases];
        let newHomeScore = interactiveGameData.homeScore;
        let newAwayScore = interactiveGameData.awayScore;
        let newGameLog = [...interactiveGameData.gameLog];

        const currentBattingLineup = interactiveGameData.currentHalfInning === 'top' ? interactiveGameData.awayLineup.batters : interactiveGameData.homeLineup.batters;
        const currentBattingIndexForTeam = interactiveGameData.currentHalfInning === 'top' ? interactiveGameData.awayBattingIndex : interactiveGameData.homeBattingIndex;
        const currentBatterInSim = currentBattingLineup[currentBattingIndexForTeam];
        const currentPitcherInSim = interactiveGameData.currentHalfInning === 'top' ? interactiveGameData.homeLineup.pitcher : interactiveGameData.awayLineup.pitcher;

        if (!currentBatterInSim || !currentPitcherInSim) {
            console.error("Invalid batter or pitcher for simulation step. Ending game for debugging.");
            onGameEnd(interactiveGameData, interactiveGameData.homeScore, interactiveGameData.awayScore);
            return;
        }

        const catcherOfPitchingTeam = Object.values(players).find(p => p.teamId === currentPitchingTeamId && p.position === 'C');

        const preAtBatEvent = handlePreAtBatEvents(newBases, players[currentPitcherInSim.id], catcherOfPitchingTeam, players, currentPitchingTeamId);

        if (preAtBatEvent.type === 'WILD_THROW') {
            newBases = preAtBatEvent.newBases;
            if (interactiveGameData.currentHalfInning === 'top') {
                newAwayScore += preAtBatEvent.runsScoredThisPlay;
            } else {
                newHomeScore += preAtBatEvent.runsScoredThisPlay;
            }

            if (preAtBatEvent.fielderUpdates.playerId) {
                const existingFielderStats = interactiveGameData.playerUpdatesCache[preAtBatEvent.fielderUpdates.playerId] || {};
                interactiveGameData.playerUpdatesCache[preAtBatEvent.fielderUpdates.playerId] = { 
                    ...existingFielderStats,
                    errors: (existingFielderStats.errors || 0) + (preAtBatEvent.fielderUpdates.errors || 0),
                    playsAttempted: (existingFielderStats.playsAttempted || 0) + (preAtBatEvent.fielderUpdates.playsAttempted || 0),
                };
            }
            
            newGameLog.push(`${players[currentBatterInSim.id].name} is at the plate. Bases: ${newBases.map(b => b ? (b === 'GHOST_RUNNER' ? 'Ghost Runner' : players[b]?.name) : 'Empty').join(', ')}. ${preAtBatEvent.logSuffix}`);
            setCurrentPlayResult("WILD THROW!");

            setInteractiveGameData(prev => ({
                ...prev,
                homeScore: newHomeScore,
                awayScore: newAwayScore,
                bases: newBases,
                gameLog: newGameLog,
                playerUpdatesCache: prev.playerUpdatesCache,
            }));

            playResultTimeoutRef.current = setTimeout(() => setCurrentPlayResult(''), 1500);

            return; 
        }

        let { outcome, runsScoredThisPlay, logSuffix, fielderUpdates, basesAfterHit, hitAngle } = simulateAtBat( 
            players[currentBatterInSim.id],
            players[currentPitcherInSim.id],
            players,
            currentPitchingTeamId,
            interactiveGameData.isPostseason,
            newBases 
        );

        let batterStatUpdates = {
            atBats: (interactiveGameData.playerUpdatesCache[currentBatterInSim.id]?.atBats || 0),
            hits: (interactiveGameData.playerUpdatesCache[currentBatterInSim.id]?.hits || 0),
            homeRuns: (interactiveGameData.playerUpdatesCache[currentBatterInSim.id]?.homeRuns || 0),
            walks: (interactiveGameData.playerUpdatesCache[currentBatterInSim.id]?.walks || 0),
            strikeOuts: (interactiveGameData.playerUpdatesCache[currentBatterInSim.id]?.strikeOuts || 0),
            runsScored: (interactiveGameData.playerUpdatesCache[currentBatterInSim.id]?.runsScored || 0),
            runsBattedIn: (interactiveGameData.playerUpdatesCache[currentBatterInSim.id]?.runsBattedIn || 0)
        };
        let pitcherStatUpdates = {
            atBatsFaced: (interactiveGameData.playerUpdatesCache[currentPitcherInSim.id]?.atBatsFaced || 0),
            strikeOutsAllowed: (interactiveGameData.playerUpdatesCache[currentPitcherInSim.id]?.strikeOutsAllowed || 0),
            walksAllowed: (interactiveGameData.playerUpdatesCache[currentPitcherInSim.id]?.walksAllowed || 0),
            hitsAllowed: (interactiveGameData.playerUpdatesCache[currentPitcherInSim.id]?.hitsAllowed || 0),
            homeRunsAllowed: (interactiveGameData.playerUpdatesCache[currentPitcherInSim.id]?.homeRunsAllowed || 0),
        };

        const oldBasesSnapshot = [...newBases]; 

        if (['HOME_RUN', 'TRIPLE', 'DOUBLE', 'SINGLE', 'WALK'].includes(outcome)) {
            newBases = basesAfterHit; 
        }

        switch (outcome) {
            case 'HOME_RUN':
                batterStatUpdates.homeRuns += 1;
                pitcherStatUpdates.homeRunsAllowed += 1;
                batterStatUpdates.hits += 1;
                setCurrentPlayResult("HOME RUN!");
                break;
            case 'TRIPLE':
                batterStatUpdates.hits += 1;
                pitcherStatUpdates.hitsAllowed += 1;
                setCurrentPlayResult("TRIPLE!");
                break;
            case 'DOUBLE':
                batterStatUpdates.hits += 1;
                pitcherStatUpdates.hitsAllowed += 1;
                setCurrentPlayResult("DOUBLE!");
                break;
            case 'SINGLE':
                batterStatUpdates.hits += 1;
                pitcherStatUpdates.hitsAllowed += 1;
                setCurrentPlayResult("SINGLE!");
                break;
            case 'WALK':
                batterStatUpdates.walks += 1;
                pitcherStatUpdates.walksAllowed += 1;
                setCurrentPlayResult("WALK!");
                break;
            case 'STRIKEOUT':
                newOuts++;
                batterStatUpdates.strikeOuts += 1;
                pitcherStatUpdates.strikeOutsAllowed += 1;
                setCurrentPlayResult("STRIKEOUT!");
                break;
            case 'OUT':
                newOuts++;
                setCurrentPlayResult("OUT!");
                break;
            default:
                break;
        }

        if (outcome !== 'OUT' && outcome !== 'STRIKEOUT') {
            for (let i = 0; i < oldBasesSnapshot.length; i++) {
                if (oldBasesSnapshot[i] && !newBases.includes(oldBasesSnapshot[i]) && oldBasesSnapshot[i] !== currentBatterInSim.id) {
                     const runnerId = oldBasesSnapshot[i];
                     interactiveGameData.playerUpdatesCache[runnerId] = {
                         ...(interactiveGameData.playerUpdatesCache[runnerId] || {}),
                         runsScored: (interactiveGameData.playerUpdatesCache[runnerId]?.runsScored || 0) + 1
                     };
                     runsScoredThisPlay++; 
                } else if (oldBasesSnapshot[i] === 'GHOST_RUNNER' && !newBases.includes('GHOST_RUNNER')) {
                    runsScoredThisPlay++;
                }
            }
        }
        
        newGameLog.push(`${players[currentBatterInSim.id].name} (${currentBattingTeam.name}): ${currentPlayResult.toLowerCase()}${logSuffix}`);

        if (interactiveGameData.currentHalfInning === 'top') {
            newAwayScore += runsScoredThisPlay;
        } else {
            newHomeScore += runsScoredThisPlay;
        }

        batterStatUpdates.atBats += (outcome !== 'WALK' ? 1 : 0);
        batterStatUpdates.runsBattedIn += runsScoredThisPlay;
        pitcherStatUpdates.atBatsFaced += 1;

        interactiveGameData.playerUpdatesCache[currentBatterInSim.id] = batterStatUpdates;
        interactiveGameData.playerUpdatesCache[currentPitcherInSim.id] = pitcherStatUpdates;

        if (fielderUpdates && players[fielderUpdates.playerId]) {
            const existingFielderStats = interactiveGameData.playerUpdatesCache[fielderUpdates.playerId] || {};
            interactiveGameData.playerUpdatesCache[fielderUpdates.playerId] = {
                ...existingFielderStats,
                errors: (existingFielderStats.errors || 0) + (fielderUpdates.errors || 0),
                goldenGlovePlays: (existingFielderStats.goldenGlovePlays || 0) + (fielderUpdates.goldenGlovePlays || 0),
                playsAttempted: (existingFielderStats.playsAttempted || 0) + (fielderUpdates.playsAttempted || 0),
                basesRobbed: (existingFielderStats.basesRobbed || 0) + (fielderUpdates.basesRobbed || 0)
            };
        }
        
        let newCurrentBatterId = null;
        let nextHomeBattingIndex = interactiveGameData.homeBattingIndex;
        let nextAwayBattingIndex = interactiveGameData.awayBattingIndex;

        if (interactiveGameData.currentHalfInning === 'top') {
            nextAwayBattingIndex = (interactiveGameData.awayBattingIndex + 1) % 9;
            newCurrentBatterId = interactiveGameData.awayLineup.batters[nextAwayBattingIndex]?.id;
        } else {
            nextHomeBattingIndex = (interactiveGameData.homeBattingIndex + 1) % 9;
            newCurrentBatterId = interactiveGameData.homeLineup.batters[nextHomeBattingIndex]?.id;
        }
        
        if (outcome !== 'STRIKEOUT' && outcome !== 'WALK') {
            // Calculate ball target coordinates using the new function
            const targetCoords = calculateBallTarget(BASE_COORDS.home.x, BASE_COORDS.home.y, hitAngle, outcome);

            setBallAnimation({ x: targetCoords.x, y: targetCoords.y, isVisible: true, hitAngle, hitType: outcome });
            
            let targetFielder = null;
            if (fielderUpdates.playerId && players[fielderUpdates.playerId]) {
                targetFielder = players[fielderUpdates.playerId];
            } else {
                const defensivePlayers = Object.values(players).filter(p => p.teamId === currentPitchingTeamId);
                const eligibleFielders = getEligibleFielders(hitAngle, defensivePlayers, outcome); 
                if (eligibleFielders.length > 0) {
                    targetFielder = eligibleFielders[0]; 
                }
            }

            if (targetFielder) {
                const fielderCoords = PLAYER_POSITIONS_COORDS[targetFielder.position];
                if (fielderCoords) {
                    setFielderAnimation({ 
                        playerId: targetFielder.id, 
                        fromX: fielderCoords.x, 
                        fromY: fielderCoords.y, 
                        toX: targetCoords.x, 
                        toY: targetCoords.y, 
                        isMoving: true 
                    });
                }
            }

            animationTimeoutRef.current = setTimeout(() => {
                setBallAnimation({ x: 0, y: 0, isVisible: false, hitAngle: 0, hitType: 'NONE' });
                setFielderAnimation({ playerId: null, fromX: 0, fromY: 0, toX: 0, toY: 0, isMoving: false }); 
                
                setInteractiveGameData(prev => ({
                    ...prev,
                    homeScore: newHomeScore,
                    awayScore: newAwayScore,
                    outs: newOuts,
                    bases: newBases,
                    gameLog: newGameLog,
                    homeBattingIndex: nextHomeBattingIndex,
                    awayBattingIndex: nextAwayBattingIndex,
                    currentBatterId: newCurrentBatterId,
                    playerUpdatesCache: prev.playerUpdatesCache,
                }));
                playResultTimeoutRef.current = setTimeout(() => setCurrentPlayResult(''), 1500);
            }, 1000); 
        } else {
            setInteractiveGameData(prev => ({
                ...prev,
                homeScore: newHomeScore,
                awayScore: newAwayScore,
                outs: newOuts,
                bases: newBases,
                gameLog: newGameLog,
                homeBattingIndex: nextHomeBattingIndex,
                awayBattingIndex: nextAwayBattingIndex,
                currentBatterId: newCurrentBatterId,
                playerUpdatesCache: prev.playerUpdatesCache,
            }));
            playResultTimeoutRef.current = setTimeout(() => setCurrentPlayResult(''), 1500);
        }
    }, [interactiveGameData, players, currentBattingTeam, currentPitchingTeamId, simulateAtBat, handlePreAtBatEvents, onGameEnd, getEligibleFielders, calculateBallTarget, BASE_COORDS.home.x, BASE_COORDS.home.y, PLAYER_POSITIONS_COORDS]); 

    useEffect(() => {
        return () => {
            clearTimeout(animationTimeoutRef.current);
            clearTimeout(playResultTimeoutRef.current);
        };
    }, []);

    if (!currentBatter || !currentPitcher || !currentBattingTeam || !currentPitchingTeam || !gameLog) {
        return <LoadingScreen />;
    }

    const homeTeamScore = interactiveGameData.homeScore;
    const awayTeamScore = interactiveGameData.awayScore;

    return (
        <div className="bg-gray-800 p-4 rounded-lg shadow-md flex flex-col items-center relative overflow-hidden">
            <h2 className="text-2xl font-bold mb-4">Live Game Simulation</h2>
            
            <div className="w-full max-w-lg bg-gray-700 rounded-lg p-4 flex justify-between items-center text-white mb-6 z-10">
                <div className="flex flex-col items-center w-1/3">
                    <span className="text-xl font-semibold">{teams[awayTeamId]?.logo} {teams[awayTeamId]?.name}</span>
                    <span className="text-4xl font-bold">{awayTeamScore}</span>
                </div>
                <div className="flex flex-col items-center w-1/3">
                    <span className="text-xl font-semibold">Inning: {currentInning} ({currentHalfInning === 'top' ? '▲' : '▼'})</span>
                    <span className="text-2xl">Outs: {outs}</span>
                    <div className="flex gap-1 mt-1">
                        {[0, 1, 2].map(i => (
                            <div key={i} className={`w-3 h-3 rounded-full ${outs > i ? 'bg-red-500' : 'bg-gray-500'}`}></div>
                        ))}
                    </div>
                </div>
                <div className="flex flex-col items-center w-1/3">
                    <span className="text-xl font-semibold">{teams[homeTeamId]?.logo} {teams[homeTeamId]?.name}</span>
                    <span className="text-4xl font-bold">{homeTeamScore}</span>
                </div>
            </div>

            {currentPlayResult && (
                <div className="absolute inset-0 flex items-center justify-center bg-black bg-opacity-70 z-20 transition-opacity duration-300">
                    <h3 className="text-5xl font-extrabold text-yellow-400 animate-pulse">
                        {currentPlayResult}
                    </h3>
                </div>
            )}

            {/* Baseball Field Image Container */}
            <div className="w-full max-w-2xl aspect-square relative overflow-hidden mb-6" style={{ width: '100%', height: 'auto', paddingBottom: `${(IMAGE_HEIGHT / IMAGE_WIDTH) * 100}%` }}>
                <img 
                    src="https://github.com/rob92893/gemini_assets/blob/main/tbl/Baseball_Field.png?raw=true" 
                    alt="Baseball Field" 
                    className="absolute top-0 left-0 w-full h-full object-contain" 
                />
                <svg 
                    viewBox={`0 0 ${IMAGE_WIDTH} ${IMAGE_HEIGHT}`} 
                    className="absolute top-0 left-0 w-full h-full"
                    style={{ pointerEvents: 'none' }} 
                >
                    {/* Bases occupied by runners (player dots centered on bases) */}
                    {bases[0] && <circle cx={BASE_COORDS.first.x} cy={BASE_COORDS.first.y} r="20" fill="#4299E1" stroke="white" strokeWidth="2" />}
                    {bases[1] && <circle cx={BASE_COORDS.second.x} cy={BASE_COORDS.second.y} r="20" fill="#4299E1" stroke="white" strokeWidth="2" />}
                    {bases[2] && <circle cx={BASE_COORDS.third.x} cy={BASE_COORDS.third.y} r="20" fill="#4299E1" stroke="white" strokeWidth="2" />}

                    {/* Player Positions */}
                    {Object.entries(fieldPlayerPositions).map(([id, pos]) => (
                        <g key={id}>
                            <circle 
                                cx={pos.x} 
                                cy={pos.y} 
                                r="25" 
                                fill={pos.isBatter ? "yellow" : (pos.isPitcher ? "red" : (pos.isRunner ? "#4299E1" : "blue"))} 
                                stroke="white" 
                                strokeWidth="2"
                            >
                                {fielderAnimation.playerId === id && fielderAnimation.isMoving && (
                                    <>
                                        <animate
                                            attributeName="cx"
                                            from={fielderAnimation.fromX}
                                            to={fielderAnimation.toX}
                                            dur="0.6s"
                                            fill="freeze"
                                            begin="0s"
                                        />
                                        <animate
                                            attributeName="cy"
                                            from={fielderAnimation.fromY}
                                            to={fielderAnimation.y} // Fielder animates to target ball position
                                            dur="0.6s"
                                            fill="freeze"
                                            begin="0s"
                                            onAnimationEnd={() => setFielderAnimation(prev => ({ ...prev, isMoving: false }))}
                                        />
                                    </>
                                )}
                            </circle>
                            <text 
                                x={pos.x} 
                                y={pos.y + 5} 
                                textAnchor="middle" 
                                alignmentBaseline="middle" 
                                fontSize="16" 
                                fill="black"
                                style={{pointerEvents: 'none', fontWeight: 'bold'}}
                            >
                                {pos.label === 'B' ? 'B' : pos.label}
                            </text>
                            <text 
                                x={pos.x} 
                                y={pos.y - 30} 
                                textAnchor="middle" 
                                alignmentBaseline="middle" 
                                fontSize="14" 
                                fill="white"
                                style={{pointerEvents: 'none'}}
                            >
                                {pos.teamLogo}
                            </text>
                        </g>
                    ))}

                    {/* Animated Ball */}
                    {ballAnimation.isVisible && (
                        <circle 
                            cx={BASE_COORDS.home.x} 
                            cy={BASE_COORDS.home.y} 
                            r="15" 
                            fill="white" 
                            stroke="black" 
                            strokeWidth="1"
                            key={`ball-${interactiveGameData.currentBatterId}-${interactiveGameData.outs}`} 
                        >
                            <animate
                                attributeName="cx"
                                from={BASE_COORDS.home.x}
                                to={ballAnimation.x} 
                                dur="0.8s"
                                fill="freeze"
                                begin="0s"
                            />
                            <animate
                                attributeName="cy"
                                from={BASE_COORDS.home.y}
                                to={ballAnimation.y} 
                                dur="0.8s"
                                fill="freeze"
                                begin="0s"
                                onAnimationEnd={() => setBallAnimation(prev => ({ ...prev, isVisible: false }))}
                            />
                        </circle>
                    )}
                </svg>
            </div>


            {/* Game Controls */}
            <div className="flex gap-4 mb-4">
                <button
                    onClick={runPlay}
                    disabled={isGameOver || ballAnimation.isVisible || fielderAnimation.isMoving}
                    className="bg-purple-600 hover:bg-purple-700 text-white font-bold py-2 px-6 rounded-lg transition duration-300 disabled:opacity-50"
                >
                    Simulate Play
                </button>
                {isGameOver && (
                    <button
                        onClick={() => onGameEnd(interactiveGameData, homeScore, awayScore)}
                        className="bg-blue-600 hover:bg-blue-700 text-white font-bold py-2 px-6 rounded-lg transition duration-300"
                    >
                        End Game
                    </button>
                )}
            </div>

            {/* Game Log */}
            <div className="bg-gray-700 rounded-lg p-4 w-full max-w-md max-h-64 overflow-y-auto custom-scrollbar text-sm">
                <h3 className="font-bold border-b border-gray-600 pb-2 mb-2">Game Log</h3>
                {gameLog && gameLog.map((log, index) => (
                    <p key={index} className="mb-1">{log}</p>
                ))}
            </div>
        </div>
    );
}


// --- Main App Component ---
function App() {
    const [db, setDb] = useState(null);
    const [auth, setAuth] = useState(null);
    const [userId, setUserId] = useState(null);
    const [gameState, setGameState] = useState(null);
    const [userTeamId, setUserTeamId] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [currentView, setCurrentView] = useState('dashboard'); // dashboard, roster, schedule, standings, player, trade

    // Interactive Game Simulation State
    const [interactiveGameData, setInteractiveGameData] = useState(null); // Holds state for active game simulation

    // Last Game Result for Dashboard
    const [lastGameResult, setLastGameResult] = useState(null); 

    // Confirmation Modal State
    const [showConfirmationModal, setShowConfirmationModal] = useState(false);
    const [confirmationMessage, setConfirmationMessage] = useState('');
    const [onConfirmAction, setOnConfirmAction] = useState(() => () => {});

    // --- Firebase Initialization and Auth ---
    useEffect(() => {
        try {
            const app = initializeApp(firebaseConfig);
            const firestore = getFirestore(app);
            const authInstance = getAuth(app);
            setDb(firestore);
            setAuth(authInstance);

            onAuthStateChanged(authInstance, async (user) => {
                if (user) {
                    setUserId(user.uid);
                } else {
                    try {
                        if (typeof __initial_auth_token !== 'undefined' && __initial_auth_token) {
                            await signInWithCustomToken(authInstance, __initial_auth_token);
                        } else {
                            await signInAnonymously(authInstance);
                        }
                    } catch (authError) {
                        console.error("Authentication error:", authError);
                        setError("Failed to authenticate. Please refresh the page.");
                    }
                }
            });
        } catch (e) {
            console.error("Firebase init error:", e);
            setError("Could not initialize the game environment.");
            setLoading(false);
        }
    }, []);

    // --- Game State Management ---
    // Loads initial game state, triggered by userId and db availability
    useEffect(() => {
        if (userId && db) {
            const gameDocRef = doc(db, 'artifacts', appId, 'users', userId);
            const unsubscribe = onSnapshot(gameDocRef, (docSnap) => {
                if (docSnap.exists()) {
                    const data = docSnap.data();
                    setGameState(data.gameState);
                    setUserTeamId(data.userTeamId);
                    setLastGameResult(data.lastGameResult || null); // Load last game result
                } else {
                    setGameState(null);
                    setUserTeamId(null);
                    setLastGameResult(null);
                }
                setLoading(false);
            }, (err) => {
                console.error("Snapshot error:", err);
                setError("Lost connection to the game server. Please check your internet connection.");
                setLoading(false);
            });
            return () => unsubscribe(); // Cleanup on component unmount
        }
    }, [userId, db]);

    /**
     * Generates a random number following a normal distribution using the Box-Muller transform.
     * @param {number} mean - The mean of the distribution.
     * @param {number} stdDev - The standard deviation of the distribution.
     * @returns {number} A random number from the normal distribution.
     */
    const randomNormal = (mean, stdDev) => {
        let u = 0, v = 0;
        while (u === 0) u = Math.random(); // Converting [0,1) to (0,1)
        while (v === 0) v = Math.random();
        let z = Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
        return mean + z * stdDev;
    };

    /**
     * Defines the angular segments (0-90 degrees from foul line) for each defensive position.
     * These segments determine which fielders are "in play" for a given hit angle.
     */
    const FielderSegments = {
        '3B': { min: 0, max: 21.25 },
        'SS': { min: 21.25, max: 42.5 },
        'P':  { min: 42.5, max: 47.5 }, // Narrow, central segment for pitcher (5 degrees)
        '2B': { min: 47.5, max: 68.75 },
        '1B': { min: 68.75, max: 90 },
        'LF': { min: 0, max: 30 },
        'CF': { min: 30, max: 60 },
        'RF': { min: 60, max: 90 }
    };

    /**
     * Filters a list of defensive players to find those whose position segment overlaps with the hit angle.
     * Excludes catchers from fielding batted balls.
     * @param {number} hitAngle - The angle of the batted ball.
     * @param {Array<object>} defensivePlayers - List of defensive player objects.
     * @param {string} hitType - The type of hit (e.g., 'SINGLE', 'DOUBLE', 'TRIPLE', 'OUT', 'HOME_RUN').
     * @returns {Array<object>} List of eligible fielders.
     */
    const getEligibleFielders = useCallback((hitAngle, defensivePlayers, hitType) => {
        return defensivePlayers.filter(p => {
            // Exclude catcher entirely from batted ball fielding
            if (p.position === 'C') return false; 
            
            const segment = FielderSegments[p.position];
            if (!segment) return false; // Unknown position

            // Apply specific rules for infielders/outfielders based on hit type
            if (['SINGLE', 'OUT'].includes(hitType)) {
                // Both infielders and outfielders can field singles and outs
                return hitAngle >= segment.min && hitAngle <= segment.max;
            } else if (['DOUBLE', 'TRIPLE', 'HOME_RUN'].includes(hitType)) {
                // Only outfielders should field doubles, triples, and home runs
                return ['LF', 'CF', 'RF'].includes(p.position) && hitAngle >= segment.min && hitAngle <= segment.max;
            }
            return false; // Should not happen for expected hit types
        });
    }, []); // FielderSegments is constant, no need for it in dependencies


    /**
     * Simulates a single at-bat between a batter and a pitcher using their detailed ratings.
     * Moved to App component to be accessible by both full game sim and interactive sim.
     * @param {object} batter - The batter player object.
     * @param {object} pitcher - The pitcher player object.
     * @param {object} allPlayers - A map of all players in the game (gameState.players).
     * @param {string} pitchingTeamId - The ID of the team currently pitching.
     * @param {boolean} isPostseasonGame - True if this is a postseason game (affects ghost runner).
     * @param {Array<string|null>} currentBases - The current state of bases for wild throw logic.
     * @returns {object} An object with the final outcome, runs scored, and a log suffix for fielding events.
     */
    const simulateAtBat = useCallback((batter, pitcher, allPlayers, pitchingTeamId, isPostseasonGame, currentBases) => {
        let outcome = 'OUT';
        let runsScoredThisPlay = 0;
        let logSuffix = '';
        let fielderUpdates = { playerId: null, errors: 0, goldenGlovePlays: 0, playsAttempted: 0, basesRobbed: 0 }; // To track fielder stats for this at-bat
        let basesAfterHit = [...currentBases]; // Initialize with current bases for potential wild throw modifications
        let hitAngle = 0; // Default hit angle

        // Normalize ratings to 0-1 scale for probabilities
        const batterContact = batter.ratings.contact / 100;
        const batterPower = batter.ratings.power / 100;
        const batterEye = batter.ratings.eye / 100;

        const pitcherAccuracy = pitcher.ratings.accuracy / 100;
        const pitcherHeat = pitcher.ratings.heat / 100;
        const pitcherMovement = pitcher.ratings.movement / 100;

        const randomRoll = Math.random();

        // Determine effective batter handedness for hitting tendencies and matchup
        let effectiveBatterHandedness = batter.handedness;
        if (batter.handedness === 'S') {
            // Switch hitter logic: Bat opposite of pitcher's handedness (stronger side)
            effectiveBatterHandedness = pitcher.handedness === 'R' ? 'L' : 'R';
        }

        // Apply handedness matchup influence on hit probability
        let matchupModifier = 0;
        // RHP vs RHB or LHP vs LHB (tougher for batter)
        if (effectiveBatterHandedness === pitcher.handedness) {
            matchupModifier = -0.05; 
        } 
        // RHP vs LHB or LHP vs RHB (easier for batter)
        else { 
            matchupModifier = 0.05; 
        }

        const probStrikeout = Math.max(0, (pitcherHeat * 0.4 + pitcherMovement * 0.3 + (1 - batterEye) * 0.3) / 1.5);
        const probWalk = Math.max(0, (batterEye * 0.4 + (1 - pitcherAccuracy) * 0.6) / 2);

        if (randomRoll < probStrikeout) {
            outcome = 'STRIKEOUT';
        } else if (randomRoll < probStrikeout + probWalk) {
            outcome = 'WALK';
        } else {
            const hitProb = Math.max(0, (batterContact * 0.6 + batterEye * 0.2 + (1 - pitcherAccuracy) * 0.2) / 1.2 + matchupModifier);
            
            if (Math.random() < hitProb) {
                const hitTypeRoll = Math.random();
                const probHR = Math.max(0, (batterPower * 0.7 + (1 - pitcherHeat) * 0.3) / 3);
                const probTriple = Math.max(0, (batter.ratings.speed / 100 * 0.4 + batterContact * 0.1) / 4);
                const probDouble = Math.max(0, (batterPower * 0.3 + batterContact * 0.3) / 2); 
                
                if (hitTypeRoll < probHR) {
                    outcome = 'HOME_RUN';
                } else if (hitTypeRoll < probHR + probTriple) {
                    outcome = 'TRIPLE';
                } else if (hitTypeRoll < probHR + probTriple + probDouble) {
                    outcome = 'DOUBLE';
                } else {
                    outcome = 'SINGLE';
                }
            } else {
                outcome = 'OUT';
            }
        }

        // --- Simulate Base Advancement on Hit/Walk ---
        if (outcome === 'HOME_RUN') {
            basesAfterHit = [null, null, null]; // Clear bases for HR
        } else if (outcome === 'TRIPLE') {
            basesAfterHit = [null, null, batter.id];
        } else if (outcome === 'DOUBLE') {
            basesAfterHit = [null, batter.id, currentBases[0]];
        } else if (outcome === 'SINGLE') {
            basesAfterHit = [batter.id, currentBases[0], currentBases[1]];
        } else if (outcome === 'WALK') {
            // Complex walk logic to advance runners
            if (currentBases[0] && currentBases[1] && currentBases[2]) { // Bases loaded walk
                runsScoredThisPlay++; // Runner on 3rd scores
                basesAfterHit = [batter.id, currentBases[0], currentBases[1]]; // All runners advance one base
            } else if (currentBases[0] && currentBases[1]) { // Runner on 1st, 2nd. Batter walks
                basesAfterHit = [batter.id, currentBases[0], currentBases[1]];
            } else if (currentBases[0]) { // Runner on 1st. Batter walks
                basesAfterHit = [batter.id, currentBases[0], null];
            } else { // Bases empty or only 2nd/3rd occupied. Batter walks to 1st.
                basesAfterHit = [batter.id, currentBases[0], currentBases[1]];
            }
        }
        
        // --- Fielding Logic ---
        const defensivePlayers = Object.values(allPlayers).filter(p => p.teamId === pitchingTeamId); 
        
        let fielderInvolved = null;
        const ERROR_BASE_PROBABILITY = 0.10; // Max 10% error chance for 0 fielding
        const GOLDEN_GLOVE_BASE_PROBABILITY = 0.03; // Base 3% exceptional play chance for 100 fielding
        const HR_ROBBERY_CHANCE = 0.02; // 2% chance a HR is even robbable

        // Calculate hit angle for all batted balls requiring fielding
        let meanAngle; // Mean for Gaussian distribution
        let stdDevAngle = 18; // Standard deviation for Gaussian distribution

        if (effectiveBatterHandedness === 'R') { // Right-handed batter pulls to left field
            meanAngle = 33; // Centered towards 3B/SS/LF
        } else { // Left-handed batter pulls to right field
            meanAngle = 57; // Centered towards 1B/2B/RF
        }

        // Generate hit angle using Gaussian distribution and clamp it to 0-90
        hitAngle = Math.min(90, Math.max(0, randomNormal(meanAngle, stdDevAngle)));


        if (outcome === 'HOME_RUN') {
            if (Math.random() < HR_ROBBERY_CHANCE) {
                // Select outfielder based on hit angle
                const eligibleOutfielders = getEligibleFielders(hitAngle, defensivePlayers, 'HOME_RUN');
                if (eligibleOutfielders.length > 0) {
                    // For simplicity, pick the first eligible outfielder.
                    // Could add logic for closest to center of segment if multiple overlap perfectly.
                    fielderInvolved = eligibleOutfielders[0]; 
                    fielderUpdates.playerId = fielderInvolved.id;
                    fielderUpdates.playsAttempted += 1;

                    // Robbery chance: more weighted towards fielding, less towards speed
                    const robberySuccessChance = (fielderInvolved.ratings.fielding / 100 * 0.8) + (fielderInvolved.ratings.speed / 100 * 0.2); 

                    if (Math.random() < robberySuccessChance) {
                        outcome = 'OUT'; // HR robbed
                        logSuffix = ` (HR robbed by ${fielderInvolved.name}!)`;
                        fielderUpdates.goldenGlovePlays += 1;
                        fielderUpdates.basesRobbed += 4; // Robbed a HR, prevents 4 bases
                    } else {
                        logSuffix = ` (HR ball hit deep!)`; // Attempted but failed to rob
                    }
                } else {
                    logSuffix = ` (Home Run!)`; // No eligible outfielders to attempt robbery
                }
            } else {
                logSuffix = ` (Home Run!)`; // Not a robbable HR
            }
        } else if (['OUT', 'SINGLE', 'DOUBLE', 'TRIPLE'].includes(outcome)) {
            let eligibleFielders = [];

            if (['SINGLE', 'OUT'].includes(outcome)) {
                // For singles and outs, both infielders and outfielders are eligible based on angle
                eligibleFielders = defensivePlayers.filter(p => ['1B', '2B', '3B', 'SS', 'P', 'LF', 'CF', 'RF'].includes(p.position) && hitAngle >= FielderSegments[p.position].min && hitAngle <= FielderSegments[p.position].max);
            } else if (['DOUBLE', 'TRIPLE'].includes(outcome)) {
                // For doubles and triples, only outfielders are eligible based on angle
                eligibleFielders = defensivePlayers.filter(p => ['LF', 'CF', 'RF'].includes(p.position) && hitAngle >= FielderSegments[p.position].min && hitAngle <= FielderSegments[p.position].max);
            }
            
            // Fallback if no specific fielder is found (should be rare with continuous segments)
            if (eligibleFielders.length === 0) {
                console.warn(`No eligible fielders found for angle ${hitAngle} and outcome ${outcome}. Falling back to random non-catcher fielder.`);
                eligibleFielders = defensivePlayers.filter(p => p.position !== 'C'); // Fallback to any non-catcher
            }

            if (eligibleFielders.length > 0) {
                fielderInvolved = eligibleFielders[Math.floor(Math.random() * eligibleFielders.length)]; 
            }

            if (fielderInvolved) {
                fielderUpdates.playerId = fielderInvolved.id;
                fielderUpdates.playsAttempted += 1;

                const errorChance = (100 - fielderInvolved.ratings.fielding) / 100 * ERROR_BASE_PROBABILITY;
                let speedContribution = 0;
                // Speed contributes to golden glove plays for all fielders, but more for outfielders
                if (['LF', 'CF', 'RF'].includes(fielderInvolved.position)) {
                    speedContribution = fielderInvolved.ratings.speed / 100 * 0.5; 
                } else { // Infielders and Pitchers
                    speedContribution = fielderInvolved.ratings.speed / 100 * 0.2; 
                }
                const goldenGloveChance = (fielderInvolved.ratings.fielding / 100 * GOLDEN_GLOVE_BASE_PROBABILITY) + speedContribution;

                if (Math.random() < errorChance) {
                    fielderUpdates.errors += 1;
                    if (outcome === 'SINGLE') {
                        outcome = 'DOUBLE';
                        logSuffix = ` (Error by ${fielderInvolved.name} makes it a Double!)`;
                    } else if (outcome === 'DOUBLE') {
                        outcome = 'TRIPLE';
                        logSuffix = ` (Error by ${fielderInvolved.name} makes it a Triple!)`;
                    } else if (outcome === 'TRIPLE') {
                        outcome = 'HOME_RUN'; // Error turns triple into home run
                        logSuffix = ` (Error by ${fielderInvolved.name} makes it a Home Run!)`;
                    }
                } else if (Math.random() < goldenGloveChance) {
                    fielderUpdates.goldenGlovePlays += 1;
                    if (outcome === 'SINGLE') {
                        outcome = 'OUT'; // Exceptional play turns single into out
                        logSuffix = ` (Golden Glove play by ${fielderInvolved.name} takes away the hit!)`;
                        fielderUpdates.basesRobbed += 1; // Robbed a single, prevents 1 base
                    } else if (outcome === 'DOUBLE') {
                        outcome = 'SINGLE'; // Exceptional play limits double to single
                        logSuffix = ` (Great Golden Glove play by ${fielderInvolved.name} limits it to a Single!)`;
                        fielderUpdates.basesRobbed += 1; // Robbed a double, makes it a single, prevents 1 base
                    } else if (outcome === 'TRIPLE') {
                        outcome = 'DOUBLE'; // Exceptional play limits triple to double
                        logSuffix = ` (Great Golden Glove play by ${fielderInvolved.name} limits it to a Double!)`;
                        fielderUpdates.basesRobbed += 1; // Robbed a triple, makes it a double, prevents 1 base
                    }
                }
            }
        }
        
        return { outcome, runsScoredThisPlay, logSuffix, fielderUpdates, basesAfterHit, hitAngle }; // Include hitAngle
    }, [randomNormal, getEligibleFielders]);

    /**
     * New function to handle pre-at-bat events like wild throws.
     * @param {Array<string|null>} currentBases - The current state of bases.
     * @param {object} pitcher - The current pitcher object.
     * @param {object} catcher - The current catcher object.
     * @param {object} allPlayers - All player data.
     * @param {string} pitchingTeamId - ID of the pitching team.
     * @returns {object} An object indicating if a wild throw occurred, runs scored, log suffix, and updated bases/fielder stats.
     */
    const handlePreAtBatEvents = useCallback((currentBases, pitcher, catcher, allPlayers, pitchingTeamId) => {
        let preAtBatOutcome = {
            type: 'NONE', // 'WILD_THROW' or 'NONE'
            runsScoredThisPlay: 0,
            logSuffix: '',
            fielderUpdates: { playerId: null, errors: 0, goldenGlovePlays: 0, playsAttempted: 0, basesRobbed: 0 },
            newBases: [...currentBases]
        };

        if (catcher && (currentBases[0] || currentBases[1] || currentBases[2] || currentBases.includes('GHOST_RUNNER'))) { // Only if there are runners on base (including ghost runner)
            // Wild throw chance: pitcher accuracy (low accuracy increases chance) + catcher fielding (low fielding increases chance)
            const pitcherAccuracy = pitcher.ratings.accuracy / 100;
            const wildThrowChance = (1 - pitcherAccuracy) * 0.05 + (1 - catcher.ratings.fielding / 100) * 0.07;

            if (Math.random() < wildThrowChance) {
                preAtBatOutcome.type = 'WILD_THROW';
                preAtBatOutcome.logSuffix = ` (Wild throw by ${catcher.name}!)`;
                preAtBatOutcome.fielderUpdates.playerId = catcher.id; // Assign updates to catcher
                preAtBatOutcome.fielderUpdates.errors += 1;
                preAtBatOutcome.fielderUpdates.playsAttempted += 1;

                // Create a temporary copy to iterate and modify
                let tempBases = [...preAtBatOutcome.newBases];

                // Check if runner on 3rd scores
                if (tempBases[2] !== null) {
                    preAtBatOutcome.runsScoredThisPlay++;
                    tempBases[2] = null; // Runner scores
                }

                // Move runner from 2nd to 3rd
                if (tempBases[1] !== null) {
                    tempBases[2] = tempBases[1];
                    tempBases[1] = null;
                }

                // Move runner from 1st to 2nd
                if (tempBases[0] !== null) {
                    tempBases[1] = tempBases[0];
                    tempBases[0] = null;
                }
                
                // Update newBases with advanced runners
                preAtBatOutcome.newBases = tempBases;
            }
        }
        return preAtBatOutcome;
    }, []);

    /**
     * Retrieves the active lineup for a given team from the current game state.
     * Prioritizes pre-assigned lineup positions and starting pitcher.
     * Falls back to skill-based selection if a full lineup isn't defined.
     */
    const getLineup = useCallback((team, allPlayers) => {
        let pitcher = Object.values(allPlayers).find(p => p.teamId === team.id && p.isStartingPitcher);
        // Batters should only be non-pitchers and in a lineup position
        let batters = Object.values(allPlayers)
            .filter(p => p.teamId === team.id && p.position !== 'P' && p.lineupPosition >= 0 && p.lineupPosition <= 8)
            .sort((a, b) => a.lineupPosition - b.lineupPosition);
            
        // Fallback for AI teams or if user hasn't set a full lineup (ensuring 9 batters, no pitchers)
        if (!pitcher || batters.length < 9) {
            const roster = Object.values(allPlayers).filter(p => p.teamId === team.id);
            const availablePitchers = roster.filter(p => p.position === 'P').sort((a,b) => calculateOverallPitcherRating(a.ratings) - calculateOverallPitcherRating(b.ratings)); // Lower PitcherRating is better
            const availableBatters = roster.filter(p => p.position !== 'P').sort((a,b) => calculateOverallBatterRating(b.ratings) - calculateOverallBatterRating(a.ratings)); // Higher BatterRating is better

            // If no designated pitcher, pick the best available
            if (availablePitchers.length > 0) { // If pitcher is null or undefined, assign best available
                if (!pitcher) {
                    pitcher = availablePitchers[0];
                }
            } else {
                 console.warn(`No pitchers available for team ${team.name}. Assigning a random non-pitcher as pitcher for simulation purposes.`);
                 // Fallback: If no actual pitcher, assign the highest rated fielder as pitcher. This is a very rough fallback.
                 if (roster.length > 0) {
                    pitcher = roster.sort((a,b) => calculateOverallBatterRating(b.ratings) - calculateOverallBatterRating(a.ratings))[0];
                 } else {
                    console.error(`Team ${team.name} has no players at all. Cannot form a lineup.`);
                    return { pitcher: null, batters: [] };
                 }
            }

            // Fill missing batter spots from best available non-pitchers, avoiding duplicates
            const currentBatterIds = new Set(batters.map(b => b.id));
            let filledBatters = [...batters];
            for (let i = 0; i < availableBatters.length && filledBatters.length < 9; i++) {
                const nextBatter = availableBatters[i];
                if (!currentBatterIds.has(nextBatter.id) && nextBatter.id !== (pitcher ? pitcher.id : null)) { // Ensure pitcher is not also a batter
                    filledBatters.push(nextBatter);
                    currentBatterIds.add(nextBatter.id);
                }
            }
            batters = filledBatters.slice(0, 9); // Ensure exactly 9 batters
            // If any batters were added without lineupPosition, they'll sort to the end.
            // Re-sort based on lineupPosition, then by overall rating if position is -1
            batters.sort((a, b) => {
                if (a.lineupPosition !== -1 && b.lineupPosition !== -1) return a.lineupPosition - b.lineupPosition;
                if (a.lineupPosition !== -1) return -1; // Keep player with assigned position first
                if (b.lineupPosition !== -1) return 1;  // Keep player with assigned position first
                // If both have -1, sort by overall rating
                return calculateOverallBatterRating(b.ratings) - calculateOverallBatterRating(a.ratings);
            });
        }
        return { pitcher, batters: batters.slice(0, 9) }; // Ensure exactly 9 batters
    }, []);

    /**
     * Saves the entire game state to Firestore.
     */
    const saveGameState = async (newGameState, newUserTeamId, latestGameResult = null) => {
        if (!userId || !db) {
            console.warn("Attempted to save game state before userId or db are ready.");
            return;
        }
        try {
            const gameDocRef = doc(db, 'artifacts', appId, 'users', userId);
            await setDoc(gameDocRef, { gameState: newGameState, userTeamId: newUserTeamId, lastGameResult: latestGameResult }, { merge: true });
        } catch (e) {
            console.error("Error saving game state:", e);
            setError("Failed to save your progress.");
        }
    };

    /**
     * Updates multiple player objects in the game state and saves it.
     * This is useful for bulk updates like setting a lineup.
     */
    const updatePlayersBulk = useCallback(async (playerUpdatesMap) => {
        if (!gameState || !userId || !db) return;

        const newPlayers = { ...gameState.players };
        for (const playerId in playerUpdatesMap) {
            if (newPlayers[playerId]) {
                newPlayers[playerId] = {
                    ...newPlayers[playerId],
                    ...playerUpdatesMap[playerId]
                };
            }
        }
        const newGameState = { ...gameState, players: newPlayers };
        await saveGameState(newGameState, userTeamId, lastGameResult); // Pass existing lastGameResult
        setGameState(newGameState); // Optimistic update for UI
    }, [gameState, userId, db, userTeamId, lastGameResult, saveGameState]); 


    /**
     * Creates a new game state, including generating teams, players, and initial schedules.
     * Also assigns initial lineups to all teams.
     */
    const createNewGame = async (teamId) => {
        if (!userId || !db) return;
        setLoading(true);

        const newPlayers = {};
        const teamsData = {};

        TEAMS.forEach(team => {
            teamsData[team.id] = { ...team, roster: [], wins: 0, losses: 0 };
            const pitchersCount = 4;
            const nonPitchersCount = 12;

            // Generate Pitchers
            for (let i = 0; i < pitchersCount; i++) {
                const playerId = `${team.id}_P${Date.now()}_${i}`;
                const generatedRatings = generateRandomRatings(true);
                newPlayers[playerId] = {
                    id: playerId,
                    name: generatePlayerName(),
                    age: Math.floor(Math.random() * 15) + 20, // 20-34 years old
                    teamId: team.id,
                    position: 'P',
                    ratings: generatedRatings, // New ratings object for pitcher
                    handedness: generatedRatings.handedness, // New: Pitcher handedness
                    stats: { // Seasonal stats
                        atBats: 0, hits: 0, homeRuns: 0, walks: 0, strikeOuts: 0, runsScored: 0, runsBattedIn: 0, // Batting stats
                        inningsPitched: 0, saves: 0, // Pitcher game stats
                        atBatsFaced: 0, strikeOutsAllowed: 0, walksAllowed: 0, hitsAllowed: 0, homeRunsAllowed: 0, // Pitcher outcome stats
                        avg: 0, // Calculated for batter side (will be low for pitchers)
                        baa: 0, // Calculated for pitcher side
                        errors: 0, 
                        goldenGlovePlays: 0, // Renamed
                        playsAttempted: 0, // New
                        basesRobbed: 0 // New
                    },
                    lineupPosition: -1, // -1 means not in batting lineup
                    isStartingPitcher: false // Only one will be true for the SP
                };
                teamsData[team.id].roster.push(playerId);
            }

            // Generate Non-Pitchers (Batters/Fielders)
            for (let i = 0; i < nonPitchersCount; i++) {
                const playerId = `${team.id}_NP${Date.now()}_${i}`;
                const position = POSITIONS[Math.floor(Math.random() * (POSITIONS.length -1)) + 1]; // Random non-pitcher position
                const generatedRatings = generateRandomRatings(false);
                newPlayers[playerId] = {
                    id: playerId,
                    name: generatePlayerName(),
                    age: Math.floor(Math.random() * 5) + 1, // 1-5 years old
                    teamId: team.id,
                    position,
                    ratings: generatedRatings, // New ratings object for non-pitcher
                    handedness: generatedRatings.handedness, // New: Batter handedness
                    stats: { // Seasonal stats
                        atBats: 0, hits: 0, homeRuns: 0, walks: 0, strikeOuts: 0, runsScored: 0, runsBattedIn: 0, // Batting stats
                        inningsPitched: 0, saves: 0, // Pitcher game stats (will be 0 for batters)
                        atBatsFaced: 0, strikeOutsAllowed: 0, walksAllowed: 0, hitsAllowed: 0, homeRunsAllowed: 0, // Pitcher outcome stats (will be 0 for batters)
                        avg: 0, // Calculated for batter side
                        baa: 0, // Calculated for pitcher side (will be 0 for batters)
                        errors: 0, 
                        goldenGlovePlays: 0, // Renamed
                        playsAttempted: 0, // New
                        basesRobbed: 0 // New
                    },
                    lineupPosition: -1, // -1 means not in batting lineup
                    isStartingPitcher: false // Only one will be true for the SP
                };
                teamsData[team.id].roster.push(playerId);
            }
        });
        
        // Assign initial lineups for all teams (top 9 batters + top pitcher)
        Object.values(teamsData).forEach(team => {
            const teamPlayers = Object.values(newPlayers).filter(p => p.teamId === team.id);
            const pitchers = teamPlayers.filter(p => p.position === 'P').sort((a, b) => calculateOverallPitcherRating(a.ratings) - calculateOverallPitcherRating(b.ratings)); // Lower PitcherRating is better
            const batters = teamPlayers.filter(p => p.position !== 'P').sort((a, b) => calculateOverallBatterRating(b.ratings) - calculateOverallBatterRating(a.ratings)); // Higher BatterRating is better

            // Assign starting pitcher
            if (pitchers.length > 0) {
                newPlayers[pitchers[0].id].isStartingPitcher = true;
            }

            // Assign 9 batters to lineup positions (0-8)
            for (let i = 0; i < 9; i++) {
                if (batters[i]) {
                    newPlayers[batters[i].id].lineupPosition = i;
                }
            }
        });
        
        const newGameState = {
            year: 1,
            players: newPlayers,
            teams: teamsData,
            schedule: generateSchedule(TEAMS.map(t => t.id)),
            gameIndex: 0, // Track current game in schedule
            standings: TEAMS.map(t => ({ teamId: t.id, wins: 0, losses: 0})),
            isPostseason: false, // New: Is the game in postseason?
            postseasonSeries: [], // New: Championship series games
            postseasonGameIndex: 0, // New: Current game in postseason series
            postseasonSeriesScores: {}, // New: Object to track series scores
            championshipWinnerId: null, // New: ID of the championship winner
            gameLog: [], // New: For tracking game events
        };
        
        const selectedTeamId = teamId || TEAMS[0].id; // Default to first team if not selected
        setUserTeamId(selectedTeamId);
        await saveGameState(newGameState, selectedTeamId, null); // No last game result on new game
        setGameState(newGameState);
        setLastGameResult(null);
        setCurrentView('dashboard');
        setLoading(false);
    };

    /**
     * Helper function to advance to next year (offseason logic)
     */
    const advanceToNextYear = useCallback(async (updatedGameState) => {
        updatedGameState.year++;
        updatedGameState.gameIndex = 0; // Reset game index for new season
        updatedGameState.schedule = generateSchedule(TEAMS.map(t => t.id)); // Generate new schedule
        updatedGameState.standings.forEach(t => { t.wins = 0; t.losses = 0; }); // Reset standings
        Object.values(updatedGameState.teams).forEach(t => { t.wins = 0; t.losses = 0; }); // Reset team records

        // Player aging and skill progression/regression
        Object.values(updatedGameState.players).forEach(p => {
            p.age++;

            let ageFactor = 1;
            if (p.age <= 2) ageFactor = 1.5;
            else if (p.age >= 4 && p.age <= 5) ageFactor = 0.8; 
            else if (p.age >= 6) ageFactor = 0.5; 

            const potentialFactor = (p.ratings.potential - 50) / 100; 

            const ratingKeys = ['contact', 'power', 'eye', 'speed', 'fielding', 'accuracy', 'heat', 'movement'];
            ratingKeys.forEach(key => {
                let change = (Math.random() - 0.5) * 5; 
                change += (change * potentialFactor * ageFactor);

                const injuryImpact = (p.ratings.injury - 50) / 100; 
                change += (change * injuryImpact);

                p.ratings[key] = Math.min(99, Math.max(30, p.ratings[key] + Math.round(change))); // Clamped to 30-99
            });

            p.ratings.injury = Math.min(99, Math.max(30, p.ratings.injury + Math.round((p.age >= 4 ? 1 : 0) * (Math.random() * 5)))); // Clamped to 30-99
            
            // Reset seasonal stats for players
            p.stats.hits = 0;
            p.stats.atBats = 0;
            p.stats.walks = 0;
            p.stats.homeRuns = 0;
            p.stats.strikeOuts = 0;
            p.stats.runsScored = 0;
            p.stats.runsBattedIn = 0;
            // Pitcher stats
            p.stats.inningsPitched = 0; 
            p.stats.saves = 0; 
            p.stats.atBatsFaced = 0;
            p.stats.strikeOutsAllowed = 0;
            p.stats.walksAllowed = 0;
            p.stats.hitsAllowed = 0;
            p.stats.homeRunsAllowed = 0;
            // Fielding stats
            p.stats.errors = 0;
            p.stats.goldenGlovePlays = 0;
            p.stats.playsAttempted = 0;
            p.stats.basesRobbed = 0;


            // Re-calculate AVG/BAA based on reset stats (will be 0 for new season start)
            p.stats.avg = (p.stats.atBats > 0) ? (p.stats.hits / p.stats.atBats) : 0;
            p.stats.baa = (p.stats.atBatsFaced > 0) ? (p.stats.hitsAllowed / p.stats.atBatsFaced) : 0; // For pitchers, hits allowed / atBats faced
        });

        // Clear postseason state for the new year
        updatedGameState.isPostseason = false;
        updatedGameState.postseasonSeries = [];
        updatedGameState.postseasonGameIndex = 0;
        updatedGameState.postseasonSeriesScores = {};
        updatedGameState.championshipWinnerId = null;
        updatedGameState.gameLog = []; // Clear game log for new season start

        setLastGameResult(null); // Clear last game result at season start
        await saveGameState(updatedGameState, userId, null);
        setLoading(false);
        setCurrentView('dashboard'); // Always return to dashboard after season change
    }, [saveGameState, userId]);


    /**
     * Simulates a single baseball game between two teams.
     * @param {object} game - The game object with home and away team IDs.
     * @param {object} currentGameState - The current full game state for player and team data.
     * @param {boolean} isPostseasonGame - True if this is a postseason game (affects extra inning rules).
     * @returns {object} Game result including winner, loser, scores, and player stat updates.
     */
    const simulateFullGame = useCallback((game, currentGameState, isPostseasonGame = false) => {
        const homeTeam = currentGameState.teams[game.home];
        const awayTeam = currentGameState.teams[game.away];
        
        let homeScore = 0;
        let awayScore = 0;
        
        const homeLineup = getLineup(homeTeam, currentGameState.players);
        const awayLineup = getLineup(awayTeam, currentGameState.players);
        
        // Basic check for valid lineups before simulation
        if (!homeLineup.pitcher || !awayLineup.pitcher || homeLineup.batters.length < 9 || awayLineup.batters.length < 9) {
            console.error(`Could not form a valid lineup for simulation of game between ${homeTeam.name} and ${awayTeam.name}. Forfeiting game.`);
            return { 
                winner: game.home, 
                loser: game.away, 
                homeScore: 1, // Award win to home team by default on forfeit
                awayScore: 0, 
                playerUpdates: [],
                home: game.home, away: game.away // Include original game teams for result display
            }; 
        }

        let playerUpdates = []; // To track hits and at-bats for players
        
        let currentInning = 1;
        let gameOver = false;
        let homeBattingIndex = 0; // Persistent batting index for AI teams
        let awayBattingIndex = 0;

        while (!gameOver) {
            // --- Top of the Inning (Away team bats) ---
            let outs = 0;
            let bases = [null, null, null];
            if (currentInning > REGULAR_SEASON_MAX_INNINGS && !isPostseasonGame) {
                bases[1] = 'GHOST_RUNNER'; // Ghost runner on 2nd for regular season extra innings
            }

            while(outs < 3) {
                const currentBatterForAtBat = awayLineup.batters[awayBattingIndex % 9]; 
                const currentPitcher = homeLineup.pitcher;
                const catcherOfPitchingTeam = Object.values(currentGameState.players).find(p => p.teamId === homeTeam.id && p.position === 'C');

                let atBatOccurred = false;
                while (!atBatOccurred) { // Loop for pre-at-bat events until an actual at-bat can occur
                    const preAtBatEvent = handlePreAtBatEvents(bases, currentPitcher, catcherOfPitchingTeam, currentGameState.players, homeTeam.id);
                    if (preAtBatEvent.type === 'WILD_THROW') {
                        bases = preAtBatEvent.newBases;
                        awayScore += preAtBatEvent.runsScoredThisPlay;

                        // Apply fielder updates for wild throw (catcher)
                        const catcherUpdate = playerUpdates.find(u => u.playerId === preAtBatEvent.fielderUpdates.playerId);
                        if (catcherUpdate) {
                            catcherUpdate.errors += (preAtBatEvent.fielderUpdates.errors || 0);
                            catcherUpdate.playsAttempted += (preAtBatEvent.fielderUpdates.playsAttempted || 0);
                        } else {
                            playerUpdates.push({ ...preAtBatEvent.fielderUpdates, playerId: preAtBatEvent.fielderUpdates.playerId });
                        }
                        // Continue loop for same batter, checking for another wild throw or then the at-bat
                    } else {
                        atBatOccurred = true; // No wild throw, proceed to at-bat
                    }
                }

                // If we reach here, no wild throws occurred for this batter on this "play" opportunity
                let { outcome, runsScoredThisPlay: currentRunsScoredThisPlay, logSuffix, fielderUpdates, basesAfterHit } = simulateAtBat( 
                    currentBatterForAtBat, currentPitcher, currentGameState.players, homeTeam.id, isPostseasonGame, bases 
                );

                let batterUpdate = playerUpdates.find(u => u.playerId === currentBatterForAtBat.id);
                if (!batterUpdate) {
                    batterUpdate = { playerId: currentBatterForAtBat.id, atBats: 0, hits: 0, homeRuns: 0, walks: 0, strikeOuts: 0, runsScored: 0, runsBattedIn: 0, errors: 0, goldenGlovePlays: 0, playsAttempted: 0, basesRobbed: 0 }; 
                    playerUpdates.push(batterUpdate);
                }
                let pitcherUpdate = playerUpdates.find(u => u.playerId === currentPitcher.id);
                if (!pitcherUpdate) {
                    pitcherUpdate = { playerId: currentPitcher.id, atBatsFaced: 0, strikeOutsAllowed: 0, walksAllowed: 0, hitsAllowed: 0, homeRunsAllowed: 0, inningsPitched: 0, saves: 0, errors: 0, goldenGlovePlays: 0, playsAttempted: 0, basesRobbed: 0 }; 
                    playerUpdates.push(pitcherUpdate);
                }
                let currentFielderUpdate = null;
                if (fielderUpdates.playerId) {
                    currentFielderUpdate = playerUpdates.find(u => u.playerId === fielderUpdates.playerId);
                    if (!currentFielderUpdate) {
                        currentFielderUpdate = { playerId: fielderUpdates.playerId, atBats: 0, hits: 0, homeRuns: 0, walks: 0, strikeOuts: 0, runsScored: 0, runsBattedIn: 0, errors: 0, goldenGlovePlays: 0, playsAttempted: 0, basesRobbed: 0 }; 
                        playerUpdates.push(currentFielderUpdate);
                    }
                }

                const oldBasesSnapshot = [...bases]; 

                if (['HOME_RUN', 'TRIPLE', 'DOUBLE', 'SINGLE', 'WALK'].includes(outcome)) {
                    bases = basesAfterHit;
                }

                switch (outcome) {
                    case 'HOME_RUN':
                        batterUpdate.homeRuns += 1;
                        pitcherUpdate.homeRunsAllowed += 1;
                        batterUpdate.hits += 1;
                        break;
                    case 'TRIPLE':
                        batterUpdate.hits += 1;
                        pitcherUpdate.hitsAllowed += 1;
                        break;
                    case 'DOUBLE':
                        batterUpdate.hits += 1;
                        pitcherUpdate.hitsAllowed += 1;
                        break;
                    case 'SINGLE':
                        batterUpdate.hits += 1;
                        pitcherUpdate.hitsAllowed += 1;
                        break;
                    case 'WALK':
                        batterUpdate.walks += 1;
                        pitcherUpdate.walksAllowed += 1;
                        break;
                    case 'STRIKEOUT':
                        outs++;
                        batterUpdate.strikeOuts += 1;
                        pitcherUpdate.strikeOutsAllowed += 1;
                        break;
                    case 'OUT':
                        outs++;
                        break;
                    default:
                        break;
                }
                
                if (outcome !== 'OUT' && outcome !== 'STRIKEOUT' && outcome !== 'HOME_RUN') { 
                    for (let i = 0; i < oldBasesSnapshot.length; i++) {
                        if (oldBasesSnapshot[i] && !bases.includes(oldBasesSnapshot[i]) && oldBasesSnapshot[i] !== currentBatterForAtBat.id) {
                            let runnerUpdate = playerUpdates.find(u => u.playerId === oldBasesSnapshot[i]);
                            if (runnerUpdate) runnerUpdate.runsScored++;
                            currentRunsScoredThisPlay++;
                        } else if (oldBasesSnapshot[i] === 'GHOST_RUNNER' && !bases.includes('GHOST_RUNNER')) {
                            currentRunsScoredThisPlay++;
                        }
                    }
                } else if (outcome === 'HOME_RUN') {
                     for (let i = 0; i < oldBasesSnapshot.length; i++) {
                        if (oldBasesSnapshot[i] && !bases.includes(oldBasesSnapshot[i]) && oldBasesSnapshot[i] !== currentBatterForAtBat.id) {
                            let runnerUpdate = playerUpdates.find(u => u.playerId === oldBasesSnapshot[i]);
                            if (runnerUpdate) runnerUpdate.runsScored++;
                            currentRunsScoredThisPlay++;
                        } else if (oldBasesSnapshot[i] === 'GHOST_RUNNER' && !bases.includes('GHOST_RUNNER')) {
                            currentRunsScoredThisPlay++;
                        }
                    }
                }

                awayScore += currentRunsScoredThisPlay;
                batterUpdate.atBats += (outcome !== 'WALK' ? 1 : 0);
                batterUpdate.runsBattedIn += currentRunsScoredThisPlay;
                pitcherUpdate.atBatsFaced += 1;

                if (currentFielderUpdate) {
                    currentFielderUpdate.errors += (fielderUpdates.errors || 0);
                    currentFielderUpdate.goldenGlovePlays += (fielderUpdates.goldenGlovePlays || 0);
                    currentFielderUpdate.playsAttempted += (fielderUpdates.playsAttempted || 0);
                    currentFielderUpdate.basesRobbed += (fielderUpdates.basesRobbed || 0);
                }

                awayBattingIndex = (awayBattingIndex + 1) % 9;
            }
            if (outs > 0) {
                let pitcherUpdate = playerUpdates.find(u => u.playerId === homeLineup.pitcher.id);
                if (pitcherUpdate) {
                    pitcherUpdate.inningsPitched = (pitcherUpdate.inningsPitched || 0) + 1;
                }
            }
            
            // --- Bottom of the Inning (Home team bats) ---
            outs = 0;
            bases = [null, null, null];
            if (currentInning > REGULAR_SEASON_MAX_INNINGS && !isPostseasonGame) {
                bases[1] = 'GHOST_RUNNER';
            }
            
            while(outs < 3) {
                const currentBatterForAtBat = homeLineup.batters[homeBattingIndex % 9]; 
                const currentPitcher = awayLineup.pitcher;
                const catcherOfPitchingTeam = Object.values(currentGameState.players).find(p => p.teamId === awayTeam.id && p.position === 'C');

                let atBatOccurred = false;
                while (!atBatOccurred) {
                    const preAtBatEvent = handlePreAtBatEvents(bases, currentPitcher, catcherOfPitchingTeam, currentGameState.players, awayTeam.id); // Fixed typo here
                    if (preAtBatEvent.type === 'WILD_THROW') {
                        bases = preAtBatEvent.newBases;
                        homeScore += preAtBatEvent.runsScoredThisPlay;
                        
                        const catcherUpdate = playerUpdates.find(u => u.playerId === preAtBatEvent.fielderUpdates.playerId);
                        if (catcherUpdate) {
                            catcherUpdate.errors += (preAtBatEvent.fielderUpdates.errors || 0);
                            catcherUpdate.playsAttempted += (preAtBatEvent.fielderUpdates.playsAttempted || 0);
                        } else {
                            playerUpdates.push({ ...preAtBatEvent.fielderUpdates, playerId: preAtBatEvent.fielderUpdates.playerId });
                        }
                    } else {
                        atBatOccurred = true;
                    }
                }

                let { outcome, runsScoredThisPlay: currentRunsScoredThisPlay, logSuffix, fielderUpdates, basesAfterHit } = simulateAtBat( 
                    currentBatterForAtBat, currentPitcher, currentGameState.players, awayTeam.id, isPostseasonGame, bases 
                );

                let batterUpdate = playerUpdates.find(u => u.playerId === currentBatterForAtBat.id);
                if (!batterUpdate) {
                    batterUpdate = { playerId: currentBatterForAtBat.id, atBats: 0, hits: 0, homeRuns: 0, walks: 0, strikeOuts: 0, runsScored: 0, runsBattedIn: 0, errors: 0, goldenGlovePlays: 0, playsAttempted: 0, basesRobbed: 0 }; 
                    playerUpdates.push(batterUpdate);
                }
                let pitcherUpdate = playerUpdates.find(u => u.playerId === currentPitcher.id);
                if (!pitcherUpdate) {
                    pitcherUpdate = { playerId: currentPitcher.id, atBatsFaced: 0, strikeOutsAllowed: 0, walksAllowed: 0, hitsAllowed: 0, homeRunsAllowed: 0, inningsPitched: 0, saves: 0, errors: 0, goldenGlovePlays: 0, playsAttempted: 0, basesRobbed: 0 }; 
                    playerUpdates.push(pitcherUpdate);
                }
                currentFielderUpdate = null;
                if (fielderUpdates.playerId) {
                    currentFielderUpdate = playerUpdates.find(u => u.playerId === fielderUpdates.playerId);
                    if (!currentFielderUpdate) {
                        currentFielderUpdate = { playerId: fielderUpdates.playerId, atBats: 0, hits: 0, homeRuns: 0, walks: 0, strikeOuts: 0, runsScored: 0, runsBattedIn: 0, errors: 0, goldenGlovePlays: 0, playsAttempted: 0, basesRobbed: 0 }; 
                        playerUpdates.push(currentFielderUpdate);
                    }
                }

                const oldBasesSnapshot = [...bases]; 

                if (['HOME_RUN', 'TRIPLE', 'DOUBLE', 'SINGLE', 'WALK'].includes(outcome)) {
                    bases = basesAfterHit;
                }

                switch (outcome) {
                    case 'HOME_RUN':
                        batterUpdate.homeRuns += 1;
                        pitcherUpdate.homeRunsAllowed += 1;
                        batterUpdate.hits += 1;
                        break;
                    case 'TRIPLE':
                        batterUpdate.hits += 1;
                        pitcherUpdate.hitsAllowed += 1;
                        break;
                    case 'DOUBLE':
                        batterUpdate.hits += 1;
                        pitcherUpdate.hitsAllowed += 1;
                        break;
                    case 'SINGLE':
                        batterUpdate.hits += 1;
                        pitcherUpdate.hitsAllowed += 1;
                        break;
                    case 'WALK':
                        batterUpdate.walks += 1;
                        pitcherUpdate.walksAllowed += 1;
                        break;
                    case 'STRIKEOUT':
                        outs++;
                        batterUpdate.strikeOuts += 1;
                        pitcherUpdate.strikeOutsAllowed += 1;
                        break;
                    case 'OUT':
                        outs++;
                        break;
                    default:
                        break;
                }
                
                if (outcome !== 'OUT' && outcome !== 'STRIKEOUT' && outcome !== 'HOME_RUN') { 
                    for (let i = 0; i < oldBasesSnapshot.length; i++) {
                        if (oldBasesSnapshot[i] && !bases.includes(oldBasesSnapshot[i]) && oldBasesSnapshot[i] !== currentBatterForAtBat.id) {
                            let runnerUpdate = playerUpdates.find(u => u.playerId === oldBasesSnapshot[i]);
                            if (runnerUpdate) runnerUpdate.runsScored++;
                            currentRunsScoredThisPlay++;
                        } else if (oldBasesSnapshot[i] === 'GHOST_RUNNER' && !bases.includes('GHOST_RUNNER')) {
                            currentRunsScoredThisPlay++;
                        }
                    }
                } else if (outcome === 'HOME_RUN') {
                     for (let i = 0; i < oldBasesSnapshot.length; i++) {
                        if (oldBasesSnapshot[i] && !bases.includes(oldBasesSnapshot[i]) && oldBasesSnapshot[i] !== currentBatterForAtBat.id) {
                            let runnerUpdate = playerUpdates.find(u => u.playerId === oldBasesSnapshot[i]);
                            if (runnerUpdate) runnerUpdate.runsScored++;
                            currentRunsScoredThisPlay++;
                        } else if (oldBasesSnapshot[i] === 'GHOST_RUNNER' && !bases.includes('GHOST_RUNNER')) {
                            currentRunsScoredThisPlay++;
                        }
                    }
                }


                homeScore += currentRunsScoredThisPlay;
                batterUpdate.atBats += (outcome !== 'WALK' ? 1 : 0); 
                batterUpdate.runsBattedIn += currentRunsScoredThisPlay;
                pitcherUpdate.atBatsFaced += 1; 

                if (currentFielderUpdate) {
                    currentFielderUpdate.errors += (fielderUpdates.errors || 0);
                    currentFielderUpdate.goldenGlovePlays += (fielderUpdates.goldenGlovePlays || 0);
                    currentFielderUpdate.playsAttempted += (fielderUpdates.playsAttempted || 0);
                    currentFielderUpdate.basesRobbed += (fielderUpdates.basesRobbed || 0);
                }

                homeBattingIndex = (homeBattingIndex + 1) % 9;
                if (currentInning >= REGULAR_SEASON_MAX_INNINGS && homeScore > awayScore) {
                    gameOver = true;
                    break;
                }
            }
            if (outs > 0) {
                let pitcherUpdate = playerUpdates.find(u => u.playerId === awayLineup.pitcher.id);
                if (pitcherUpdate) {
                    pitcherUpdate.inningsPitched = (pitcherUpdate.inningsPitched || 0) + 1;
                }
            }

            if (gameOver) break;

            if (currentInning >= REGULAR_SEASON_MAX_INNINGS && homeScore !== awayScore) {
                gameOver = true;
            } else if (currentInning >= REGULAR_SEASON_MAX_INNINGS && homeScore === awayScore) {
                currentInning++;
            } else {
                currentInning++;
            }
        }
        
        const finalWinner = homeScore > awayScore ? game.home : game.away;
        const finalLoser = homeScore > awayScore ? game.away : game.home;

        if (finalWinner === game.home && homeScore - awayScore <= 3 && homeLineup.pitcher.id) { 
            let pitcherUpdate = playerUpdates.find(u => u.playerId === homeLineup.pitcher.id);
            if (pitcherUpdate) pitcherUpdate.saves = (pitcherUpdate.saves || 0) + 1;
        } else if (finalWinner === game.away && awayScore - homeScore <= 3 && awayLineup.pitcher.id) { 
            let pitcherUpdate = playerUpdates.find(u => u.playerId === awayLineup.pitcher.id);
            if (pitcherUpdate) pitcherUpdate.saves = (pitcherUpdate.saves || 0) + 1;
        }

        return { 
            winner: finalWinner, 
            loser: finalLoser, 
            homeScore, 
            awayScore, 
            playerUpdates,
            home: game.home, 
            away: game.away
        };
    }, [simulateAtBat, getLineup, handlePreAtBatEvents]);

    /**
     * Simulates the next game in the schedule or advances to the next season if the current season is over.
     */
    const simulateNextGame = async () => {
        if (!gameState) return;
        setLoading(true);
        let updatedGameState = JSON.parse(JSON.stringify(gameState)); // Deep copy

        if (updatedGameState.gameIndex < updatedGameState.schedule.length) {
            // Regular season game simulation
            const nextGame = updatedGameState.schedule[updatedGameState.gameIndex];
            const isUserGame = nextGame.home === userTeamId || nextGame.away === userTeamId;

            if (isUserGame && !interactiveGameData) { // Start interactive game if it's the user's game and not already active
                const homeTeam = updatedGameState.teams[nextGame.home];
                const awayTeam = updatedGameState.teams[nextGame.away];

                const homeLineup = getLineup(homeTeam, updatedGameState.players);
                const awayLineup = getLineup(awayTeam, updatedGameState.players);

                if (!homeLineup.pitcher || !awayLineup.pitcher || homeLineup.batters.length < 9 || awayLineup.batters.length < 9) {
                     console.error("User team or opponent lineup not valid for interactive game. Skipping.");
                     // Fallback to full sim or error
                     const result = simulateFullGame(nextGame, updatedGameState, false); 
                     
                     updatedGameState.teams[result.winner].wins++;
                     updatedGameState.teams[result.loser].losses++;
                     const winnerStandings = updatedGameState.standings.find(t => t.teamId === result.winner);
                     const loserStandings = updatedGameState.standings.find(t => t.teamId === result.loser);
                     if (winnerStandings) winnerStandings.wins++;
                     if (loserStandings) loserStandings.losses++;
                     
                     result.playerUpdates.forEach(update => {
                        const player = updatedGameState.players[update.playerId];
                        if (player) {
                            player.stats.atBats += (update.atBats || 0);
                            player.stats.hits += (update.hits || 0);
                            player.stats.homeRuns += (update.homeRuns || 0);
                            player.stats.walks += (update.walks || 0);
                            player.stats.strikeOuts += (update.strikeOuts || 0);
                            player.stats.runsScored += (update.runsScored || 0);
                            player.stats.runsBattedIn += (update.runsBattedIn || 0);

                            if(player.position === 'P') {
                                player.stats.atBatsFaced += (update.atBatsFaced || 0);
                                player.stats.strikeOutsAllowed += (update.strikeOutsAllowed || 0);
                                player.stats.walksAllowed += (update.walksAllowed || 0);
                                player.stats.hitsAllowed += (update.hitsAllowed || 0);
                                player.stats.homeRunsAllowed += (update.homeRunsAllowed || 0);
                                player.stats.inningsPitched += (update.inningsPitched || 0);
                                player.stats.saves += (update.saves || 0);
                            }
                            player.stats.errors += (update.errors || 0); 
                            player.stats.goldenGlovePlays += (update.goldenGlovePlays || 0); 
                            player.stats.playsAttempted += (update.playsAttempted || 0); 
                            player.stats.basesRobbed += (update.basesRobbed || 0); 
                             player.stats.avg = (player.stats.atBats > 0) ? (player.stats.hits / player.stats.atBats) : 0;
                            player.stats.baa = (player.stats.atBatsFaced > 0) ? (player.stats.hitsAllowed / player.stats.atBatsFaced) : 0;
                        }
                     });
                     updatedGameState.gameIndex++;
                     setLastGameResult(result);
                     await saveGameState(updatedGameState, userTeamId, result);
                     setLoading(false);
                     return;
                }

                setInteractiveGameData({
                    currentInning: 1,
                    currentHalfInning: 'top', 
                    homeScore: 0,
                    awayScore: 0,
                    outs: 0,
                    bases: [null, null, null],
                    homeBattingIndex: 0, 
                    awayBattingIndex: 0, 
                    currentPitcherId: homeLineup.pitcher?.id,
                    currentBatterId: awayLineup.batters[0]?.id, 
                    gameLog: [],
                    homeTeamId: nextGame.home,
                    awayTeamId: nextGame.away,
                    homeLineup,
                    awayLineup,
                    playerUpdatesCache: {},
                    isPostseason: false 
                });
                setCurrentView('gameSim'); 
                setLoading(false);
            } else { 
                const result = simulateFullGame(nextGame, updatedGameState, false); 

                updatedGameState.teams[result.winner].wins++;
                updatedGameState.teams[result.loser].losses++;

                const winnerStandings = updatedGameState.standings.find(t => t.teamId === result.winner);
                const loserStandings = updatedGameState.standings.find(t => t.teamId === result.loser);
                if (winnerStandings) winnerStandings.wins++;
                if (loserStandings) loserStandings.losses++;
                
                result.playerUpdates.forEach(update => {
                    const player = updatedGameState.players[update.playerId];
                    if (player) {
                        player.stats.atBats += (update.atBats || 0);
                        player.stats.hits += (update.hits || 0);
                        player.stats.homeRuns += (update.homeRuns || 0);
                        player.stats.walks += (update.walks || 0);
                        player.stats.strikeOuts += (update.strikeOuts || 0);
                        player.stats.runsScored += (update.runsScored || 0);
                        player.stats.runsBattedIn += (update.runsBattedIn || 0);

                        if(player.position === 'P') {
                            player.stats.atBatsFaced += (update.atBatsFaced || 0); 
                            player.stats.strikeOutsAllowed += (update.strikeOutsAllowed || 0);
                            player.stats.walksAllowed += (update.walksAllowed || 0);
                            player.stats.hitsAllowed += (update.hitsAllowed || 0); 
                            player.stats.homeRunsAllowed += (update.homeRunsAllowed || 0); 
                            player.stats.inningsPitched += (update.inningsPitched || 0);
                            player.stats.saves += (update.saves || 0);
                        }
                        player.stats.errors += (update.errors || 0); 
                        player.stats.goldenGlovePlays += (update.goldenGlovePlays || 0); 
                        player.stats.playsAttempted += (update.playsAttempted || 0); 
                        player.stats.basesRobbed += (update.basesRobbed || 0); 
                        player.stats.avg = (player.stats.atBats > 0) ? (player.stats.hits / player.stats.atBats) : 0;
                        player.stats.baa = (player.stats.atBatsFaced > 0) ? (player.stats.hitsAllowed / player.stats.atBatsFaced) : 0;
                    }
                });

                updatedGameState.gameIndex++; 
                setLastGameResult(result); 
                await saveGameState(updatedGameState, userTeamId, result);
                setLoading(false);
            }
        } else if (!updatedGameState.isPostseason) {
            setLoading(true);
            const sortedStandings = [...updatedGameState.standings].sort((a, b) => {
                if (b.wins !== a.wins) return b.wins - a.wins;
                return a.losses - b.losses; 
            });
            const topTwoTeams = sortedStandings.slice(0, 2).map(s => s.teamId);

            if (topTwoTeams.length === 2) {
                updatedGameState.isPostseason = true;
                updatedGameState.postseasonGameIndex = 0;
                updatedGameState.postseasonSeries = [
                    { home: topTwoTeams[0], away: topTwoTeams[1], gameNum: 1 },
                    { home: topTwoTeams[1], away: topTwoTeams[0], gameNum: 2 },
                    { home: topTwoTeams[0], away: topTwoTeams[1], gameNum: 3 } 
                ];
                updatedGameState.postseasonSeriesScores = { [topTwoTeams[0]]: 0, [topTwoTeams[1]]: 0 }; 
                updatedGameState.championshipWinnerId = null; 
                updatedGameState.gameLog.push(`--- Postseason Begins! ---`);
                updatedGameState.gameLog.push(`${updatedGameState.teams[topTwoTeams[0]].name} vs. ${updatedGameState.teams[topTwoTeams[1]].name} in the Championship Series!`);
                await saveGameState(updatedGameState, userTeamId, null);
                setLoading(false);
                setCurrentView('dashboard'); 
            } else {
                console.warn("Not enough teams for postseason. Advancing to next year.");
                await advanceToNextYear(updatedGameState);
            }
        } else if (updatedGameState.isPostseason && updatedGameState.postseasonGameIndex < updatedGameState.postseasonSeries.length) {
            setLoading(true);
            const nextPostseasonGame = updatedGameState.postseasonSeries[updatedGameState.postseasonGameIndex];
            const result = simulateFullGame(nextPostseasonGame, updatedGameState, true); 

            result.playerUpdates.forEach(update => {
                const player = updatedGameState.players[update.playerId];
                if (player) {
                    player.stats.atBats += (update.atBats || 0);
                    player.stats.hits += (update.hits || 0);
                    player.stats.homeRuns += (update.homeRuns || 0);
                    player.stats.walks += (update.walks || 0);
                    player.stats.strikeOuts += (update.strikeOuts || 0);
                    player.stats.runsScored += (update.runsScored || 0);
                    player.stats.runsBattedIn += (update.runsBattedIn || 0);

                    if(player.position === 'P') {
                        player.stats.atBatsFaced += (update.atBatsFaced || 0);
                        player.stats.strikeOutsAllowed += (update.strikeOutsAllowed || 0);
                        player.stats.walksAllowed += (update.walksAllowed || 0);
                        player.stats.hitsAllowed += (update.hitsAllowed || 0);
                        player.stats.homeRunsAllowed += (update.homeRunsAllowed || 0);
                        player.stats.inningsPitched += (update.inningsPitched || 0);
                        player.stats.saves += (update.saves || 0);
                    }
                    player.stats.errors += (update.errors || 0); 
                    player.stats.goldenGlovePlays += (update.goldenGlovePlays || 0); 
                    player.stats.playsAttempted += (update.playsAttempted || 0); 
                    player.stats.basesRobbed += (update.basesRobbed || 0); 
                    player.stats.avg = (player.stats.atBats > 0) ? (player.stats.hits / player.stats.atBats) : 0;
                    player.stats.baa = (player.stats.atBatsFaced > 0) ? (player.stats.hitsAllowed / player.stats.atBatsFaced) : 0;
                }
            });

            const sortedStandings = [...updatedGameState.standings].sort((a, b) => {
                if (b.wins !== a.wins) return b.wins - a.wins;
                return a.losses - b.losses;
            });
            const topTwoTeams = sortedStandings.slice(0, 2).map(s => s.teamId);

            if (!updatedGameState.postseasonSeriesScores[topTwoTeams[0]]) updatedGameState.postseasonSeriesScores[topTwoTeams[0]] = 0;
            if (!updatedGameState.postseasonSeriesScores[topTwoTeams[1]]) updatedGameState.postseasonSeriesScores[topTwoTeams[1]] = 0;

            updatedGameState.postseasonSeriesScores[result.winner]++;
            
            updatedGameState.gameLog.push(`${updatedGameState.teams[result.away].name} ${result.awayScore} - ${result.homeScore} ${updatedGameState.teams[result.home].name}`);
            updatedGameState.gameLog.push(`${updatedGameState.teams[result.winner].name} wins game ${updatedGameState.postseasonGameIndex + 1}! Series: ${updatedGameState.teams[topTwoTeams[0]].name} ${updatedGameState.postseasonSeriesScores[topTwoTeams[0]]}-${updatedGameState.postseasonSeriesScores[topTwoTeams[1]]} ${updatedGameState.teams[topTwoTeams[1]].name}`);
            
            updatedGameState.postseasonGameIndex++;

            const team1Wins = updatedGameState.postseasonSeriesScores[topTwoTeams[0]];
            const team2Wins = updatedGameState.postseasonSeriesScores[topTwoTeams[1]];

            if (team1Wins >= 2 || team2Wins >= 2) { 
                updatedGameState.championshipWinnerId = team1Wins >= 2 ? topTwoTeams[0] : topTwoTeams[1];
                updatedGameState.gameLog.push(`--- ${updatedGameState.teams[updatedGameState.championshipWinnerId].name} are the Champions! ---`);
                updatedGameState.isPostseason = false; 
                updatedGameState.postseasonSeries = []; 
                updatedGameState.postseasonGameIndex = 0; 
                updatedGameState.postseasonSeriesScores = {}; 
                await saveGameState(updatedGameState, userTeamId, result); 
                await advanceToNextYear(updatedGameState); 
            } else {
                setLastGameResult(result);
                await saveGameState(updatedGameState, userTeamId, result);
                setLoading(false);
            }
        } else {
            await advanceToNextYear(updatedGameState);
        }
    };

    /**
     * Handles the end of an interactive game. Applies cached player updates to main gameState.
     */
    const handleGameEnd = useCallback(async (finalInteractiveGameData, finalHomeScore, finalAwayScore) => {
        setLoading(true);
        let updatedGameState = JSON.parse(JSON.stringify(gameState)); // Deep copy

        const game = updatedGameState.schedule[updatedGameState.gameIndex];
        const finalWinner = finalHomeScore > finalAwayScore ? game.home : game.away;
        const finalLoser = finalHomeScore > finalAwayScore ? game.away : game.home;

        // Update team wins/losses
        updatedGameState.teams[finalWinner].wins++;
        updatedGameState.teams[finalLoser].losses++;

        // Update standings
        const winnerStandings = updatedGameState.standings.find(t => t.teamId === finalWinner);
        const loserStandings = updatedGameState.standings.find(t => t.teamId === finalLoser);
        if (winnerStandings) winnerStandings.wins++;
        if (loserStandings) loserStandings.losses++;

        // Apply all player stats from cache
        for (const playerId in finalInteractiveGameData.playerUpdatesCache) {
            const cachedUpdates = finalInteractiveGameData.playerUpdatesCache[playerId];
            const player = updatedGameState.players[playerId];
            if (player) {
                player.stats.atBats += (cachedUpdates.atBats || 0);
                player.stats.hits += (cachedUpdates.hits || 0);
                player.stats.homeRuns += (cachedUpdates.homeRuns || 0);
                player.stats.walks += (cachedUpdates.walks || 0);
                player.stats.strikeOuts += (cachedUpdates.strikeOuts || 0);
                player.stats.runsScored += (cachedUpdates.runsScored || 0);
                player.stats.runsBattedIn += (cachedUpdates.runsBattedIn || 0);

                if (player.position === 'P') {
                    player.stats.atBatsFaced += (cachedUpdates.atBatsFaced || 0);
                    player.stats.strikeOutsAllowed += (cachedUpdates.strikeOutsAllowed || 0);
                    player.stats.walksAllowed += (cachedUpdates.walksAllowed || 0);
                    player.stats.hitsAllowed += (cachedUpdates.hitsAllowed || 0);
                    player.stats.homeRunsAllowed += (cachedUpdates.homeRunsAllowed || 0);
                    player.stats.inningsPitched += (cachedUpdates.inningsPitched || 0);
                    player.stats.saves += (cachedUpdates.saves || 0);
                }
                player.stats.errors += (cachedUpdates.errors || 0); 
                player.stats.goldenGlovePlays += (cachedUpdates.goldenGlovePlays || 0); 
                player.stats.playsAttempted += (cachedUpdates.playsAttempted || 0); 
                player.stats.basesRobbed += (cachedUpdates.basesRobbed || 0); 
                 player.stats.avg = (player.stats.atBats > 0) ? (player.stats.hits / player.stats.atBats) : 0;
                player.stats.baa = (player.stats.atBatsFaced > 0) ? (player.stats.hitsAllowed / player.stats.atBatsFaced) : 0;
            }
        }
        
        updatedGameState.gameIndex++; 
        const resultForDashboard = {
            winner: finalWinner,
            loser: finalLoser,
            homeScore: finalHomeScore,
            awayScore: finalAwayScore,
            home: game.home,
            away: game.away
        };

        setLastGameResult(resultForDashboard);
        await saveGameState(updatedGameState, userTeamId, resultForDashboard);
        setInteractiveGameData(null); 
        setCurrentView('dashboard'); 
        setLoading(false);
    }, [gameState, userTeamId, saveGameState]);


    // Confirmation Modal handlers
    const requestConfirmation = useCallback((message, action) => {
        setConfirmationMessage(message);
        setOnConfirmAction(() => action); 
        setShowConfirmationModal(true);
    }, []);

    const handleConfirm = useCallback(() => {
        onConfirmAction();
        setShowConfirmationModal(false);
    }, [onConfirmAction]);

    const handleCancel = useCallback(() => {
        setShowConfirmationModal(false);
    }, []);

    const isSeasonOver = gameState && gameState.gameIndex >= gameState.schedule.length;
    const championshipWinnerName = gameState?.championshipWinnerId ? gameState.teams[gameState.championshipWinnerId].name : null;

    if (loading) return <LoadingScreen />;
    if (error) return <ErrorScreen message={error} />;
    if (!gameState || !userTeamId) return <TeamSelectionScreen onSelect={createNewGame} />;

    const userTeam = gameState.teams[userTeamId];

    return (
        <div className="bg-gray-900 text-white min-h-screen font-sans">
            <div className="container mx-auto p-4 max-w-4xl">
                <Header 
                    team={userTeam} 
                    year={gameState.year} 
                    onSimulate={simulateNextGame} 
                    onNav={setCurrentView} 
                    isSeasonOver={isSeasonOver} 
                    isPostseason={gameState.isPostseason}
                    championshipWinnerName={championshipWinnerName}
                />
                <main className="mt-4">
                    {currentView === 'dashboard' && <DashboardView team={userTeam} gameState={gameState} lastGameResult={lastGameResult} />}
                    {currentView === 'roster' && <RosterView team={userTeam} players={gameState.players} updatePlayersBulk={updatePlayersBulk} />}
                    {currentView === 'schedule' && <ScheduleView schedule={gameState.schedule} gameIndex={gameState.gameIndex} teams={gameState.teams} />}
                    {currentView === 'standings' && <StandingsView standings={gameState.standings} teams={gameState.teams} />}
                    {currentView === 'gameSim' && interactiveGameData && (
                        <GameSimulationView 
                            interactiveGameData={interactiveGameData}
                            setInteractiveGameData={setInteractiveGameData}
                            teams={gameState.teams}
                            players={gameState.players}
                            onGameEnd={handleGameEnd}
                            simulateAtBat={simulateAtBat} 
                            handlePreAtBatEvents={handlePreAtBatEvents} 
                            getEligibleFielders={getEligibleFielders} 
                        />
                    )}
                </main>
                <button onClick={() => requestConfirmation('Are you sure you want to start a new game? All progress will be lost.', () => createNewGame(userTeamId))} className="mt-8 bg-red-600 hover:bg-red-700 text-white font-bold py-2 px-4 rounded-lg transition duration-300 w-full">
                    Start New Game (Resets Progress)
                </button>
            </div>
            {showConfirmationModal && (
                <ConfirmationModal
                    message={confirmationMessage}
                    onConfirm={handleConfirm}
                    onCancel={handleCancel}
                />
            )}
        </div>
    );
}

export default App;
