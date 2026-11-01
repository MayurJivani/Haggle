// Real company identities, simulated prices and simulated financials. `base` is the price the market
// was first seeded at, in euro cents, and bears no relation to the real share price; the game never
// shows live quotes. Revenue, margin and growth only set the scale of each company's simulated
// reports (see fundamentals.ts) so a bank looks like a bank and a chip designer like a chip designer.

export const SECTORS = [
  'Technology',
  'Semiconductors',
  'Healthcare',
  'Finance',
  'Energy',
  'Automotive',
  'Consumer',
  'E-commerce',
  'Telecom',
  'Aerospace & Defence',
  'Industrials',
  'Materials',
  'Food & Beverage',
  'Media',
  'Logistics',
] as const;
export type Sector = (typeof SECTORS)[number];

/**
 * Macro factors that news can push. An asset's sensitivity scales a factor event's headline impact;
 * a negative sensitivity moves the other way (a rate hike hurts growth stocks and helps banks).
 */
export const FACTORS = ['rates', 'oil', 'chips', 'consumer', 'datacenter', 'credit', 'supply', 'growth', 'euro', 'techreg'] as const;
export type Factor = (typeof FACTORS)[number];

export interface Asset {
  ticker: string;
  name: string;
  exchange: string;
  sector: Sector;
  industry: string;
  description: string;
  /** Seed price in cents, used once when the market is first initialised or the company is first listed. */
  base: number;
  /** Idiosyncratic per-tick standard deviation of the log return. */
  vol: number;
  /** Exposure to the market-wide factor. */
  beta: number;
  sens: Partial<Record<Factor, number>>;
  /** Scale of the simulated financials: annual revenue in EUR billions, net margin, revenue growth. */
  revenueBn: number;
  margin: number;
  growth: number;
  /** Seed valuation multiple: trailing P/E when profitable, price-to-sales when not. Sets the share count. */
  mult: number;
  /** Listed in the house competition. The others trade on the same market, but only in custom rooms that pick them. */
  core: boolean;
}

const SECTOR_SENS: Record<Sector, Partial<Record<Factor, number>>> = {
  Technology: { rates: 1, chips: 0.3, consumer: 0.3, datacenter: 0.5, techreg: 1, growth: 0.6, euro: 0.3 },
  Semiconductors: { rates: 0.8, chips: -0.8, datacenter: 1, growth: 0.8, supply: 0.4, euro: 0.3 },
  Healthcare: { rates: 0.3, consumer: 0.1, growth: 0.2, euro: 0.3 },
  Finance: { rates: -0.8, consumer: 0.4, credit: 1.2, growth: 0.9 },
  Energy: { oil: 1, rates: 0.2, growth: 0.5 },
  Automotive: { chips: 1, oil: -0.4, consumer: 0.8, rates: 0.5, supply: 1, growth: 0.8, euro: 0.6 },
  Consumer: { consumer: 1, oil: -0.3, rates: 0.3, supply: 0.6, growth: 0.6, euro: 0.4 },
  'E-commerce': { consumer: 1, rates: 1, supply: 0.5, techreg: 0.7, growth: 0.8, datacenter: 0.2 },
  Telecom: { rates: 0.6, growth: 0.2, techreg: 0.2 },
  'Aerospace & Defence': { oil: -0.4, supply: 0.8, growth: 0.4, euro: 0.5 },
  Industrials: { oil: -0.3, chips: 0.4, consumer: 0.3, rates: 0.4, supply: 0.7, growth: 1, datacenter: 0.3, euro: 0.5 },
  Materials: { growth: 1.2, oil: 0.2, rates: 0.3, euro: 0.3 },
  'Food & Beverage': { consumer: 0.4, oil: -0.2, rates: 0.3, supply: 0.4, growth: 0.2, euro: 0.3 },
  Media: { consumer: 0.7, rates: 0.6, techreg: 0.4, growth: 0.5 },
  Logistics: { oil: -0.8, consumer: 0.6, supply: 0.9, growth: 1, rates: 0.3 },
};

/**
 * How each sector behaves as a group, measured on the closest of Kenneth French's 12 US industry
 * portfolios (daily, 1963 to 2026; docs/data/history-stats.json, docs/calibration.md):
 * - `residual`: annual volatility left once the industry's market beta is taken out, the size of the
 *   shock every company in the sector shares;
 * - `crisis`: the industry's log loss from the October 2007 peak to the March 2009 trough over the
 *   market's (1 = fell like the market). It scales how hard a recession leans on the sector. One episode
 *   is thin evidence, so it is a guide, not an estimate.
 */
export const SECTOR_PROFILE: Record<Sector, { industry: string; residual: number; crisis: number }> = {
  Technology: { industry: 'BusEq', residual: 0.1076, crisis: 0.93 },
  Semiconductors: { industry: 'BusEq', residual: 0.1076, crisis: 0.93 },
  Healthcare: { industry: 'Hlth', residual: 0.1009, crisis: 0.53 },
  Finance: { industry: 'Money', residual: 0.0963, crisis: 1.81 },
  Energy: { industry: 'Enrgy', residual: 0.1646, crisis: 0.73 },
  Automotive: { industry: 'Durbl', residual: 0.1559, crisis: 1.88 },
  Consumer: { industry: 'Shops', residual: 0.0824, crisis: 0.64 },
  'E-commerce': { industry: 'Shops', residual: 0.0824, crisis: 0.64 },
  Telecom: { industry: 'Telcm', residual: 0.1079, crisis: 1.02 },
  'Aerospace & Defence': { industry: 'Manuf', residual: 0.0672, crisis: 1.3 },
  Industrials: { industry: 'Manuf', residual: 0.0672, crisis: 1.3 },
  Materials: { industry: 'Chems', residual: 0.0911, crisis: 0.78 },
  'Food & Beverage': { industry: 'NoDur', residual: 0.0819, crisis: 0.56 },
  Media: { industry: 'Telcm', residual: 0.1079, crisis: 1.02 },
  Logistics: { industry: 'Other', residual: 0.067, crisis: 1.28 },
};

type Row = [
  ticker: string, name: string, exchange: string, industry: string, base: number, vol: number, beta: number,
  revenueBn: number, margin: number, growth: number, mult: number, description: string, sens?: Partial<Record<Factor, number>>,
];

const ROWS: Record<Sector, Row[]> = {
  Technology: [
    ['AAPL', 'Apple', 'NASDAQ', 'Consumer electronics', 18_420, 0.0032, 1.0, 360, 0.25, 0.04, 30, 'Phones, computers and the services stacked on top of them.'],
    ['MSFT', 'Microsoft', 'NASDAQ', 'Software and cloud', 31_250, 0.0028, 0.95, 240, 0.36, 0.15, 34, 'Cloud infrastructure, office software and a gaming arm.', { datacenter: 0.9 }],
    ['GOOGL', 'Alphabet', 'NASDAQ', 'Internet services', 14_680, 0.0034, 1.05, 320, 0.28, 0.13, 22, 'Search, advertising, video and cloud computing.', { datacenter: 0.7 }],
    ['META', 'Meta Platforms', 'NASDAQ', 'Social media', 27_390, 0.0042, 1.2, 160, 0.36, 0.2, 26, 'Social networks funded by advertising, plus headset bets.'],
    ['SAP', 'SAP', 'XETRA', 'Enterprise software', 16_840, 0.003, 0.9, 34, 0.18, 0.1, 40, 'Enterprise software that runs payroll, supply chains and ledgers.', { techreg: 0.4 }],
  ],
  Semiconductors: [
    ['NVDA', 'Nvidia', 'NASDAQ', 'Accelerators and GPUs', 9_870, 0.0055, 1.4, 120, 0.53, 0.6, 45, 'Graphics and AI accelerator chips.', { datacenter: 1.6, chips: -0.4 }],
    ['ASML', 'ASML Holding', 'Euronext Amsterdam', 'Lithography equipment', 41_200, 0.0042, 1.2, 28, 0.27, 0.12, 36, 'Lithography machines every advanced chip fab depends on.'],
    ['TSM', 'TSMC', 'NYSE', 'Contract chipmaking', 12_150, 0.0038, 1.15, 82, 0.4, 0.3, 24, 'Contract manufacturer for most of the world\'s leading-edge chips.', { datacenter: 1.2 }],
    ['AMD', 'AMD', 'NASDAQ', 'Processors and GPUs', 8_430, 0.0052, 1.35, 24, 0.07, 0.2, 90, 'Processors and graphics chips for PCs, consoles and data centres.', { datacenter: 1.2 }],
    ['INTC', 'Intel', 'NASDAQ', 'Processors and foundry', 2_270, 0.0048, 1.1, 50, -0.08, -0.05, 1.8, 'PC and server processors, rebuilding its own foundry business.', { chips: -0.2 }],
  ],
  Healthcare: [
    ['NVO', 'Novo Nordisk', 'NASDAQ Copenhagen', 'Diabetes and obesity drugs', 7_960, 0.0036, 0.7, 40, 0.34, 0.22, 26, 'Diabetes and obesity treatments.'],
    ['PFE', 'Pfizer', 'NYSE', 'Pharmaceuticals', 2_640, 0.003, 0.6, 58, 0.14, -0.02, 18, 'Vaccines and a broad pharmaceutical pipeline.'],
    ['JNJ', 'Johnson & Johnson', 'NYSE', 'Pharmaceuticals and devices', 14_310, 0.0022, 0.55, 82, 0.18, 0.04, 16, 'Pharmaceuticals and medical devices.'],
    ['AZN', 'AstraZeneca', 'LSE', 'Pharmaceuticals', 12_780, 0.0028, 0.6, 50, 0.13, 0.12, 30, 'Oncology, cardiovascular and respiratory medicines.'],
    ['LLY', 'Eli Lilly', 'NYSE', 'Pharmaceuticals', 68_400, 0.004, 0.75, 42, 0.24, 0.32, 60, 'Diabetes, obesity and Alzheimer\'s medicines.'],
  ],
  Finance: [
    ['JPM', 'JPMorgan Chase', 'NYSE', 'Diversified bank', 19_840, 0.0028, 1.05, 165, 0.3, 0.06, 12, 'Retail, commercial and investment banking.'],
    ['GS', 'Goldman Sachs', 'NYSE', 'Investment bank', 38_760, 0.0034, 1.2, 50, 0.24, 0.1, 15, 'Investment banking, trading and asset management.', { credit: 1.4 }],
    ['HSBA', 'HSBC', 'LSE', 'Global bank', 790, 0.0028, 0.95, 62, 0.33, 0.03, 8, 'Global bank with deep roots in Asia.'],
    ['BNP', 'BNP Paribas', 'Euronext Paris', 'Diversified bank', 6_350, 0.003, 1.05, 48, 0.24, 0.03, 7, 'Eurozone banking and insurance group.'],
    ['V', 'Visa', 'NYSE', 'Payments', 25_480, 0.0024, 0.9, 33, 0.53, 0.1, 29, 'Card payments network.', { rates: 0.2, consumer: 0.7, credit: 0.3 }],
  ],
  Energy: [
    ['XOM', 'ExxonMobil', 'NYSE', 'Integrated oil and gas', 10_260, 0.003, 0.8, 320, 0.1, -0.02, 13, 'Oil and gas production, refining and chemicals.'],
    ['SHEL', 'Shell', 'LSE', 'Integrated oil and gas', 3_140, 0.0028, 0.8, 270, 0.06, -0.06, 12, 'Integrated oil, gas and LNG trading.'],
    ['TTE', 'TotalEnergies', 'Euronext Paris', 'Integrated energy', 5_870, 0.0028, 0.8, 200, 0.08, -0.05, 9, 'Oil, gas and a growing power business.'],
    ['NEE', 'NextEra Energy', 'NYSE', 'Utilities and renewables', 6_920, 0.0026, 0.6, 23, 0.25, 0.04, 22, 'Regulated utility and the largest wind and solar operator.', { oil: -0.3, rates: 0.9, datacenter: 0.4 }],
    ['ORSTED', 'Orsted', 'NASDAQ Copenhagen', 'Offshore wind', 3_980, 0.0046, 0.9, 9.5, -0.08, -0.1, 1.8, 'Offshore wind farm developer.', { oil: -0.4, rates: 1.1 }],
  ],
  Automotive: [
    ['TSLA', 'Tesla', 'NASDAQ', 'Electric vehicles', 21_650, 0.0062, 1.6, 90, 0.08, 0.01, 110, 'Electric cars, batteries and charging.', { chips: 0.8, oil: -0.6, rates: 0.9, consumer: 0.8 }],
    ['VOW3', 'Volkswagen', 'XETRA', 'Mass-market carmaker', 9_840, 0.0034, 1.05, 320, 0.04, 0.0, 4, 'Mass-market and luxury car brands from Wolfsburg.'],
    ['BMW', 'BMW', 'XETRA', 'Premium cars', 8_710, 0.003, 1.0, 142, 0.05, -0.05, 7, 'Premium cars and motorcycles.'],
    ['TM', 'Toyota', 'Tokyo SE', 'Mass-market carmaker', 16_290, 0.0026, 0.85, 290, 0.1, 0.06, 8, 'The world\'s largest carmaker by volume, hybrids first.', { euro: 0.2 }],
    ['BYD', 'BYD', 'HKEX', 'Electric vehicles and batteries', 3_640, 0.0046, 1.2, 100, 0.05, 0.3, 20, 'Electric and plug-in hybrid cars, plus the batteries inside them.', { oil: -0.5, euro: 0 }],
  ],
  Consumer: [
    ['MC', 'LVMH', 'Euronext Paris', 'Luxury goods', 64_350, 0.0032, 1.0, 85, 0.15, 0.0, 24, 'Luxury fashion, leather goods, wine and spirits.'],
    ['OR', "L'Oreal", 'Euronext Paris', 'Cosmetics', 36_420, 0.0024, 0.75, 43, 0.14, 0.05, 32, 'Cosmetics, skincare and hair products in every price tier.'],
    ['PG', 'Procter & Gamble', 'NYSE', 'Household products', 15_630, 0.0018, 0.45, 77, 0.18, 0.02, 25, 'Detergent, razors, nappies and toothpaste.', { consumer: 0.3 }],
    ['NKE', 'Nike', 'NYSE', 'Sportswear', 7_120, 0.0034, 0.9, 47, 0.08, -0.08, 30, 'Sportswear and sneakers.'],
    ['WMT', 'Walmart', 'NYSE', 'Discount retail', 8_740, 0.0022, 0.55, 630, 0.025, 0.05, 36, 'The world\'s largest retailer by revenue.', { consumer: 0.4 }],
  ],
  'E-commerce': [
    ['AMZN', 'Amazon', 'NASDAQ', 'Online retail and cloud', 16_380, 0.0036, 1.15, 590, 0.09, 0.11, 40, 'Online retail and the largest cloud platform.', { consumer: 0.9, rates: 0.8, datacenter: 0.8 }],
    ['BABA', 'Alibaba', 'NYSE', 'Online marketplaces', 8_610, 0.0046, 1.1, 125, 0.1, 0.05, 12, 'Chinese online marketplaces and cloud computing.', { techreg: 1.2, euro: 0 }],
    ['SHOP', 'Shopify', 'NYSE', 'Commerce software', 7_420, 0.0056, 1.45, 8.2, 0.14, 0.25, 70, 'Online-store software for millions of merchants.'],
    ['UBER', 'Uber', 'NYSE', 'Ride hailing and delivery', 6_870, 0.0046, 1.3, 40, 0.1, 0.17, 30, 'Ride hailing, food delivery and freight.', { oil: -0.4 }],
    ['BKNG', 'Booking Holdings', 'NASDAQ', 'Online travel', 410_500, 0.0034, 1.1, 22, 0.25, 0.1, 28, 'Booking.com, Priceline and Kayak.', { oil: -0.3 }],
  ],
  Telecom: [
    ['TMUS', 'T-Mobile US', 'NASDAQ', 'Wireless carrier', 19_870, 0.0024, 0.6, 76, 0.14, 0.04, 22, 'America\'s fastest-growing wireless network.'],
    ['VZ', 'Verizon', 'NYSE', 'Telecom operator', 3_720, 0.002, 0.45, 124, 0.13, 0.01, 10, 'Wireless and broadband across the United States.'],
    ['DTE', 'Deutsche Telekom', 'XETRA', 'Telecom operator', 2_910, 0.0022, 0.55, 115, 0.1, 0.03, 13, 'German telecoms giant and majority owner of T-Mobile US.'],
    ['ORA', 'Orange', 'Euronext Paris', 'Telecom operator', 1_020, 0.002, 0.5, 40, 0.06, 0.01, 12, 'French operator with footprints across Europe and Africa.'],
    ['VOD', 'Vodafone', 'LSE', 'Telecom operator', 85, 0.0026, 0.6, 37, -0.04, -0.03, 0.6, 'Mobile networks in Europe and Africa, mid-restructuring.'],
  ],
  'Aerospace & Defence': [
    ['AIR', 'Airbus', 'Euronext Paris', 'Commercial aircraft', 15_430, 0.0032, 1.05, 69, 0.06, 0.06, 30, 'Commercial aircraft, helicopters and defence.', { oil: -0.7 }],
    ['BA', 'Boeing', 'NYSE', 'Commercial aircraft', 17_840, 0.0046, 1.15, 62, -0.15, -0.1, 1.7, 'Commercial jets and defence systems.', { oil: -0.7 }],
    ['SAF', 'Safran', 'Euronext Paris', 'Aircraft engines', 20_910, 0.003, 1.0, 27, 0.12, 0.15, 30, 'Jet engines and aircraft equipment.', { oil: -0.5 }],
    ['RHM', 'Rheinmetall', 'XETRA', 'Defence systems', 52_400, 0.0048, 0.8, 9.8, 0.08, 0.36, 70, 'Armoured vehicles, ammunition and air defence.', { oil: 0, growth: -0.2 }],
    ['LMT', 'Lockheed Martin', 'NYSE', 'Defence systems', 42_150, 0.0022, 0.5, 66, 0.08, 0.05, 20, 'Fighter jets, missiles and space systems.', { oil: 0, growth: -0.2 }],
  ],
  Industrials: [
    ['SIE', 'Siemens', 'XETRA', 'Industrial automation', 17_260, 0.0026, 0.95, 77, 0.11, 0.03, 18, 'Factory automation, rail and smart infrastructure.'],
    ['CAT', 'Caterpillar', 'NYSE', 'Heavy machinery', 29_870, 0.003, 1.05, 60, 0.17, -0.03, 16, 'Construction and mining machinery.', { oil: 0.3 }],
    ['DE', 'Deere & Company', 'NYSE', 'Farm machinery', 36_210, 0.003, 1.0, 48, 0.13, -0.15, 18, 'Tractors, combines and precision-agriculture software.', { oil: 0.1 }],
    ['HON', 'Honeywell', 'NASDAQ', 'Diversified industrial', 18_940, 0.0024, 0.9, 36, 0.15, 0.03, 23, 'Building controls, aerospace parts and industrial automation.'],
    ['SU', 'Schneider Electric', 'Euronext Paris', 'Electrical equipment', 22_480, 0.003, 1.05, 38, 0.11, 0.08, 30, 'Power management and data-centre electrical systems.', { datacenter: 0.9 }],
  ],
  Materials: [
    ['BHP', 'BHP Group', 'ASX', 'Diversified mining', 2_470, 0.0034, 1.05, 52, 0.15, -0.05, 15, 'Iron ore, copper and potash from Australia to Chile.'],
    ['RIO', 'Rio Tinto', 'LSE', 'Diversified mining', 5_830, 0.0034, 1.05, 50, 0.19, -0.02, 10, 'Iron ore, aluminium and copper.'],
    ['GLEN', 'Glencore', 'LSE', 'Mining and commodity trading', 410, 0.0038, 1.15, 210, 0.003, -0.05, 60, 'Mining and the world\'s largest commodity trading house.', { oil: 0.4 }],
    ['FCX', 'Freeport-McMoRan', 'NYSE', 'Copper mining', 3_960, 0.0044, 1.4, 23, 0.08, 0.1, 30, 'The largest listed copper miner.', { datacenter: 0.4 }],
    ['BAS', 'BASF', 'XETRA', 'Chemicals', 4_380, 0.003, 1.0, 66, 0.02, -0.04, 30, 'The world\'s largest chemical producer.', { oil: -0.4, supply: 0.5 }],
  ],
  'Food & Beverage': [
    ['KO', 'Coca-Cola', 'NYSE', 'Soft drinks', 5_920, 0.0018, 0.5, 44, 0.23, 0.03, 25, 'Soft drinks bottled in nearly every country.', { consumer: 0.4 }],
    ['PEP', 'PepsiCo', 'NASDAQ', 'Snacks and drinks', 14_280, 0.0018, 0.5, 85, 0.1, 0.01, 22, 'Soft drinks plus Lay\'s, Doritos and Quaker.', { consumer: 0.4 }],
    ['NESN', 'Nestle', 'SIX Swiss', 'Packaged food', 8_960, 0.0018, 0.5, 92, 0.12, -0.02, 22, 'Packaged food, coffee and pet care.', { consumer: 0.4, euro: -0.2 }],
    ['ABI', 'AB InBev', 'Euronext Brussels', 'Brewing', 5_420, 0.0026, 0.8, 55, 0.11, 0.02, 18, 'The world\'s largest brewer: Budweiser, Stella, Corona.'],
    ['MCD', "McDonald's", 'NYSE', 'Restaurants', 26_540, 0.0018, 0.6, 24, 0.32, 0.02, 25, 'Burgers in more than a hundred countries, mostly franchised.', { consumer: 0.6 }],
  ],
  Media: [
    ['NFLX', 'Netflix', 'NASDAQ', 'Streaming', 78_920, 0.0042, 1.15, 36, 0.24, 0.15, 45, 'The biggest subscription streaming service.'],
    ['DIS', 'Walt Disney', 'NYSE', 'Entertainment', 10_870, 0.003, 1.05, 85, 0.07, 0.04, 33, 'Studios, parks, ESPN and Disney+.', { oil: -0.2 }],
    ['SPOT', 'Spotify', 'NYSE', 'Audio streaming', 47_260, 0.0048, 1.25, 16, 0.07, 0.17, 80, 'Music and podcast streaming.'],
    ['SONY', 'Sony Group', 'Tokyo SE', 'Games and electronics', 2_040, 0.003, 0.9, 80, 0.07, 0.04, 18, 'PlayStation, image sensors, music and films.', { chips: -0.2, euro: 0.3 }],
    ['NTDOY', 'Nintendo', 'Tokyo SE', 'Video games', 6_150, 0.0034, 0.75, 10, 0.25, 0.1, 30, 'Consoles and characters: Mario, Zelda, Pokemon.', { euro: 0.3 }],
  ],
  Logistics: [
    ['DHL', 'DHL Group', 'XETRA', 'Parcels and freight', 3_960, 0.0028, 0.9, 82, 0.04, 0.0, 15, 'Express parcels, freight and logistics.', { oil: -0.6, consumer: 0.6 }],
    ['UPS', 'United Parcel Service', 'NYSE', 'Parcels and freight', 11_630, 0.0028, 0.95, 84, 0.07, -0.02, 18, 'Brown trucks and an air fleet moving parcels worldwide.'],
    ['FDX', 'FedEx', 'NYSE', 'Parcels and freight', 23_150, 0.0032, 1.05, 82, 0.05, -0.01, 15, 'Overnight air delivery and ground parcels.'],
    ['MAERSK', 'A.P. Moller-Maersk', 'NASDAQ Copenhagen', 'Container shipping', 128_400, 0.0046, 1.1, 50, 0.1, 0.1, 6, 'Container ships, ports and inland logistics.', { supply: -0.8, oil: -0.5 }],
    ['RYA', 'Ryanair', 'Euronext Dublin', 'Airlines', 1_780, 0.0038, 1.2, 13.5, 0.14, 0.15, 12, 'Europe\'s largest low-cost airline.', { oil: -1.2, consumer: 0.8 }],
  ],
};

/** Five more per sector, offered only to custom rooms. */
const EXTRA_ROWS: Record<Sector, Row[]> = {
  Technology: [
    ['ORCL', 'Oracle', 'NYSE', 'Databases and cloud', 15_640, 0.0036, 1.05, 54, 0.2, 0.08, 30, 'Databases, business software and a fast-growing cloud.', { datacenter: 0.9 }],
    ['ADBE', 'Adobe', 'NASDAQ', 'Creative software', 39_820, 0.0038, 1.15, 21, 0.28, 0.1, 25, 'Photoshop, Acrobat and the subscriptions around them.'],
    ['CRM', 'Salesforce', 'NYSE', 'Business software', 24_310, 0.0038, 1.15, 37, 0.17, 0.09, 38, 'Customer-management software sold by subscription.'],
    ['IBM', 'IBM', 'NYSE', 'Enterprise IT', 19_760, 0.0026, 0.8, 62, 0.11, 0.02, 24, 'Mainframes, hybrid cloud and consulting for large companies.'],
    ['NOW', 'ServiceNow', 'NYSE', 'Workflow software', 76_450, 0.0044, 1.2, 11, 0.16, 0.2, 90, 'Software that runs IT and back-office workflows.'],
  ],
  Semiconductors: [
    ['AVGO', 'Broadcom', 'NASDAQ', 'Chips and infrastructure software', 15_120, 0.0048, 1.25, 50, 0.22, 0.2, 55, 'Networking chips, custom accelerators and enterprise software.', { datacenter: 1.3 }],
    ['QCOM', 'Qualcomm', 'NASDAQ', 'Mobile chips', 14_230, 0.0042, 1.2, 38, 0.26, 0.06, 16, 'The chips and patents inside most smartphones.', { consumer: 0.5 }],
    ['MU', 'Micron', 'NASDAQ', 'Memory chips', 9_540, 0.0056, 1.4, 28, 0.13, 0.15, 24, 'DRAM and flash memory, one of the most cyclical chip businesses.', { datacenter: 1.1 }],
    ['IFX', 'Infineon', 'XETRA', 'Power and automotive chips', 3_480, 0.0044, 1.25, 16, 0.1, 0.03, 28, 'Power chips for cars, factories and renewable energy.', { chips: 0.2 }],
    ['ARM', 'Arm Holdings', 'NASDAQ', 'Chip designs', 10_860, 0.0062, 1.5, 3.8, 0.17, 0.22, 160, 'Licenses the processor designs inside nearly every phone.'],
  ],
  Healthcare: [
    ['MRK', 'Merck & Co', 'NYSE', 'Pharmaceuticals', 8_460, 0.0026, 0.55, 58, 0.25, 0.05, 15, 'Cancer immunotherapy, vaccines and animal health.'],
    ['NOVN', 'Novartis', 'SIX Swiss', 'Pharmaceuticals', 9_780, 0.0024, 0.55, 46, 0.24, 0.07, 18, 'Prescription medicines across heart, cancer and immunology.', { euro: -0.2 }],
    ['ROG', 'Roche', 'SIX Swiss', 'Pharmaceuticals and diagnostics', 27_340, 0.0024, 0.55, 62, 0.15, 0.03, 18, 'Cancer drugs and the world\'s largest diagnostics business.', { euro: -0.2 }],
    ['ABBV', 'AbbVie', 'NYSE', 'Pharmaceuticals', 16_890, 0.0028, 0.6, 52, 0.15, 0.06, 28, 'Immunology and neuroscience medicines, Botox among them.'],
    ['ISRG', 'Intuitive Surgical', 'NASDAQ', 'Surgical robots', 47_520, 0.004, 1.1, 8.5, 0.27, 0.15, 65, 'Da Vinci surgical robots and the instruments they consume.'],
  ],
  Finance: [
    ['BAC', 'Bank of America', 'NYSE', 'Diversified bank', 3_970, 0.0032, 1.2, 98, 0.26, 0.04, 13, 'American consumer banking, wealth and markets.'],
    ['MS', 'Morgan Stanley', 'NYSE', 'Investment bank', 11_240, 0.0034, 1.2, 58, 0.2, 0.08, 15, 'Wealth management, investment banking and trading.', { credit: 1.3 }],
    ['MA', 'Mastercard', 'NYSE', 'Payments', 44_680, 0.0026, 0.95, 26, 0.45, 0.11, 35, 'The second great card payments network.', { rates: 0.2, consumer: 0.7, credit: 0.3 }],
    ['ALV', 'Allianz', 'XETRA', 'Insurance', 28_950, 0.0024, 0.85, 110, 0.09, 0.04, 12, 'Europe\'s largest insurer, and owner of asset manager PIMCO.', { rates: -0.5, credit: 0.7 }],
    ['SAN', 'Santander', 'BME Madrid', 'Diversified bank', 540, 0.0034, 1.15, 58, 0.2, 0.05, 7, 'Retail banking across Spain, Britain and Latin America.'],
  ],
  Energy: [
    ['CVX', 'Chevron', 'NYSE', 'Integrated oil and gas', 13_870, 0.003, 0.8, 180, 0.09, -0.02, 15, 'Oil and gas production from the Permian to Kazakhstan.'],
    ['BP', 'BP', 'LSE', 'Integrated oil and gas', 480, 0.0034, 0.85, 190, 0.03, -0.05, 14, 'Oil and gas major rebalancing its renewables plans.'],
    ['ENI', 'Eni', 'Borsa Italiana', 'Integrated oil and gas', 1_420, 0.003, 0.8, 90, 0.04, -0.04, 11, 'Italian oil and gas major with deep ties to North Africa.'],
    ['EQNR', 'Equinor', 'Oslo Bors', 'Oil, gas and offshore wind', 2_360, 0.0034, 0.8, 95, 0.09, -0.06, 8, 'Norway\'s North Sea oil and gas producer.'],
    ['ENPH', 'Enphase Energy', 'NASDAQ', 'Solar equipment', 5_730, 0.0064, 1.5, 1.3, 0.1, 0.02, 60, 'Microinverters and batteries for home solar.', { oil: -0.3, rates: 1.2 }],
  ],
  Automotive: [
    ['F', 'Ford', 'NYSE', 'Mass-market carmaker', 960, 0.0036, 1.15, 170, 0.03, 0.02, 9, 'Pickups, vans and a costly electric pivot.'],
    ['GM', 'General Motors', 'NYSE', 'Mass-market carmaker', 4_670, 0.0036, 1.15, 175, 0.04, 0.03, 7, 'Chevrolet, Cadillac and America\'s biggest truck franchise.'],
    ['STLA', 'Stellantis', 'Euronext Milan', 'Mass-market carmaker', 1_180, 0.004, 1.2, 160, 0.02, -0.08, 10, 'Jeep, Peugeot, Fiat and a dozen more brands.'],
    ['RACE', 'Ferrari', 'Euronext Milan', 'Luxury sports cars', 39_860, 0.0032, 0.9, 7, 0.23, 0.11, 46, 'Scarce red cars with a waiting list.', { consumer: 0.3, chips: 0.3 }],
    ['MBG', 'Mercedes-Benz', 'XETRA', 'Premium cars', 5_520, 0.003, 1.0, 145, 0.07, -0.04, 6, 'Premium cars and vans from Stuttgart.'],
  ],
  Consumer: [
    ['COST', 'Costco', 'NASDAQ', 'Warehouse clubs', 86_230, 0.0024, 0.65, 270, 0.03, 0.07, 50, 'Membership warehouses that sell in bulk at thin margins.', { consumer: 0.4 }],
    ['HD', 'Home Depot', 'NYSE', 'Home improvement', 34_560, 0.0028, 0.95, 160, 0.09, 0.03, 24, 'DIY and trade supplies, tied to the housing market.', { rates: 0.7 }],
    ['ADS', 'adidas', 'XETRA', 'Sportswear', 19_420, 0.0038, 1.05, 24, 0.05, 0.1, 30, 'Three stripes on boots, trainers and kits.'],
    ['ITX', 'Inditex', 'BME Madrid', 'Fast fashion', 4_680, 0.003, 0.95, 39, 0.15, 0.07, 24, 'Zara and its sisters, with stores restocked within weeks.'],
    ['RMS', 'Hermes', 'Euronext Paris', 'Luxury goods', 221_400, 0.003, 0.85, 16, 0.3, 0.1, 48, 'Silk scarves and handbags with waiting lists.'],
  ],
  'E-commerce': [
    ['MELI', 'MercadoLibre', 'NASDAQ', 'Online marketplaces', 178_300, 0.0052, 1.35, 22, 0.09, 0.3, 50, 'Latin America\'s largest online marketplace and payments app.', { euro: 0 }],
    ['EBAY', 'eBay', 'NASDAQ', 'Online marketplaces', 6_240, 0.0036, 1.05, 10, 0.2, 0.01, 15, 'Second-hand goods and collectibles at auction.'],
    ['PDD', 'PDD Holdings', 'NASDAQ', 'Online marketplaces', 10_380, 0.0058, 1.25, 52, 0.25, 0.2, 11, 'Pinduoduo in China and Temu everywhere else.', { techreg: 1.2, euro: 0 }],
    ['ABNB', 'Airbnb', 'NASDAQ', 'Home rentals', 11_920, 0.0046, 1.25, 11, 0.24, 0.1, 28, 'Rooms and homes rented out by their owners.', { oil: -0.3 }],
    ['ZAL', 'Zalando', 'XETRA', 'Online fashion', 2_860, 0.0056, 1.4, 11, 0.03, 0.05, 28, 'Europe\'s largest online fashion store.'],
  ],
  Telecom: [
    ['T', 'AT&T', 'NYSE', 'Telecom operator', 2_140, 0.0022, 0.5, 122, 0.1, 0.01, 12, 'American wireless and fibre.'],
    ['CMCSA', 'Comcast', 'NASDAQ', 'Cable and broadband', 3_380, 0.0026, 0.7, 124, 0.12, 0.01, 9, 'Cable broadband, NBC and Universal theme parks.', { consumer: 0.3 }],
    ['TEF', 'Telefonica', 'BME Madrid', 'Telecom operator', 410, 0.0026, 0.6, 40, 0.03, -0.01, 18, 'Spanish operator, known as O2 and Movistar.'],
    ['BTA', 'BT Group', 'LSE', 'Telecom operator', 150, 0.0028, 0.6, 24, 0.05, -0.01, 12, 'Britain\'s largest broadband and mobile provider.'],
    ['NTT', 'Nippon Telegraph and Telephone', 'Tokyo SE', 'Telecom operator', 92, 0.0022, 0.45, 86, 0.08, 0.01, 11, 'Japan\'s former phone monopoly, now also a data-centre giant.', { euro: 0.2, datacenter: 0.3 }],
  ],
  'Aerospace & Defence': [
    ['RTX', 'RTX', 'NYSE', 'Engines and missiles', 11_460, 0.0028, 0.8, 75, 0.07, 0.07, 30, 'Pratt & Whitney engines and Raytheon missiles.', { oil: -0.3 }],
    ['GE', 'GE Aerospace', 'NYSE', 'Aircraft engines', 21_780, 0.0036, 1.1, 40, 0.13, 0.12, 45, 'The engines on most of the world\'s narrow-body jets.', { oil: -0.5 }],
    ['NOC', 'Northrop Grumman', 'NYSE', 'Defence systems', 45_670, 0.0024, 0.5, 39, 0.08, 0.04, 20, 'Stealth bombers, missile systems and space hardware.', { oil: 0, growth: -0.2 }],
    ['BAE', 'BAE Systems', 'LSE', 'Defence systems', 1_780, 0.0032, 0.55, 33, 0.07, 0.12, 24, 'Warships, armoured vehicles and fighter jet parts.', { oil: 0, growth: -0.2 }],
    ['LDO', 'Leonardo', 'Borsa Italiana', 'Defence and helicopters', 3_150, 0.004, 0.75, 19, 0.06, 0.1, 25, 'Helicopters, defence electronics and aircraft structures.', { oil: 0, growth: -0.2 }],
  ],
  Industrials: [
    ['ABB', 'ABB', 'SIX Swiss', 'Electrification and robots', 4_930, 0.0028, 1.0, 31, 0.12, 0.05, 24, 'Electrical gear and factory robots.', { datacenter: 0.6, euro: -0.1 }],
    ['MMM', '3M', 'NYSE', 'Diversified industrial', 12_360, 0.003, 0.95, 23, 0.14, -0.01, 20, 'Post-it notes, abrasives and thousands of industrial materials.'],
    ['ETN', 'Eaton', 'NYSE', 'Electrical equipment', 29_180, 0.0034, 1.1, 25, 0.15, 0.09, 30, 'Power distribution equipment for grids and data centres.', { datacenter: 1 }],
    ['HIT', 'Hitachi', 'Tokyo SE', 'Industrial conglomerate', 2_340, 0.003, 1.05, 60, 0.07, 0.04, 26, 'Power grids, rail systems and industrial software.', { euro: 0.2 }],
    ['ALO', 'Alstom', 'Euronext Paris', 'Trains and rail signalling', 2_180, 0.0042, 1.1, 18, 0.02, 0.04, 30, 'High-speed trains, metros and rail signalling.'],
  ],
  Materials: [
    ['VALE', 'Vale', 'NYSE', 'Iron ore mining', 920, 0.0044, 1.15, 38, 0.17, -0.03, 6, 'Brazil\'s iron ore giant, tied to Chinese steel demand.', { euro: 0 }],
    ['LIN', 'Linde', 'NASDAQ', 'Industrial gases', 41_230, 0.0024, 0.85, 31, 0.21, 0.03, 30, 'Oxygen, hydrogen and other gases on long contracts.'],
    ['NEM', 'Newmont', 'NYSE', 'Gold mining', 4_760, 0.0048, 0.6, 18, 0.15, 0.07, 18, 'The world\'s largest gold miner, a favourite in uneasy markets.', { growth: -0.3, rates: 0.6 }],
    ['AAL', 'Anglo American', 'LSE', 'Diversified mining', 2_840, 0.0042, 1.2, 28, 0.05, -0.03, 24, 'Copper, iron ore and diamonds.'],
    ['NUE', 'Nucor', 'NYSE', 'Steel', 12_930, 0.0038, 1.2, 30, 0.08, -0.04, 13, 'America\'s largest steelmaker, melting scrap in electric furnaces.'],
  ],
  'Food & Beverage': [
    ['MDLZ', 'Mondelez', 'NASDAQ', 'Snacks', 6_080, 0.002, 0.5, 36, 0.11, 0.03, 20, 'Oreo, Cadbury and Milka.', { consumer: 0.4 }],
    ['DGE', 'Diageo', 'LSE', 'Spirits', 2_680, 0.0026, 0.65, 19, 0.17, -0.01, 18, 'Johnnie Walker, Guinness and Smirnoff.'],
    ['SBUX', 'Starbucks', 'NASDAQ', 'Coffee chains', 8_740, 0.0032, 0.9, 34, 0.1, 0.02, 28, 'Green aprons in more than eighty countries.', { consumer: 0.7 }],
    ['BN', 'Danone', 'Euronext Paris', 'Dairy and water', 7_120, 0.002, 0.5, 28, 0.07, 0.02, 22, 'Yoghurt, baby formula and Evian water.', { consumer: 0.3 }],
    ['HEIA', 'Heineken', 'Euronext Amsterdam', 'Brewing', 7_460, 0.0026, 0.7, 30, 0.07, 0.02, 20, 'Green bottles and the world\'s second-largest brewer.'],
  ],
  Media: [
    ['WBD', 'Warner Bros. Discovery', 'NASDAQ', 'Entertainment', 1_090, 0.0054, 1.3, 38, -0.03, -0.04, 0.7, 'Warner films, HBO and a heavy load of debt.', { credit: 1 }],
    ['EA', 'Electronic Arts', 'NASDAQ', 'Video games', 14_260, 0.003, 0.75, 7.2, 0.15, 0.03, 34, 'EA Sports football, The Sims and Battlefield.'],
    ['UMG', 'Universal Music Group', 'Euronext Amsterdam', 'Recorded music', 2_420, 0.0032, 0.85, 12, 0.13, 0.07, 28, 'The largest record label, Taylor Swift\'s among them.'],
    ['WPP', 'WPP', 'LSE', 'Advertising agencies', 620, 0.0042, 1.15, 16, 0.03, -0.04, 14, 'A holding company of advertising and media agencies.'],
    ['TTWO', 'Take-Two', 'NASDAQ', 'Video games', 18_840, 0.0042, 1.05, 5.8, -0.1, 0.1, 5, 'Grand Theft Auto and NBA 2K.'],
  ],
  Logistics: [
    ['DAL', 'Delta Air Lines', 'NYSE', 'Airlines', 4_780, 0.0044, 1.3, 58, 0.07, 0.05, 8, 'America\'s most profitable large airline.', { oil: -1.2, consumer: 0.8 }],
    ['UNP', 'Union Pacific', 'NYSE', 'Railroads', 21_450, 0.0024, 0.9, 23, 0.28, 0.02, 20, 'Freight rail across the western United States.', { oil: -0.2 }],
    ['KNIN', 'Kuehne+Nagel', 'SIX Swiss', 'Freight forwarding', 19_680, 0.003, 0.95, 24, 0.05, 0.01, 22, 'Books space on ships and planes for other people\'s goods.', { supply: -0.3 }],
    ['LHA', 'Lufthansa', 'XETRA', 'Airlines', 690, 0.0042, 1.25, 38, 0.03, 0.04, 7, 'Germany\'s flag carrier and a big cargo operator.', { oil: -1.2, consumer: 0.8 }],
    ['XPO', 'XPO', 'NYSE', 'Road freight', 11_250, 0.005, 1.35, 7.5, 0.05, 0.03, 34, 'Less-than-truckload freight across North America.'],
  ],
};

const build = (sector: Sector, rows: Row[], core: boolean): Asset[] =>
  rows.map(([ticker, name, exchange, industry, base, vol, beta, revenueBn, margin, growth, mult, description, sens]) => ({
    ticker, name, exchange, sector, industry, description, base, vol, beta, revenueBn, margin, growth, mult, core,
    sens: { ...SECTOR_SENS[sector], ...sens },
  }));

/** Every company on the market. They all tick on the one tape; a competition lists a subset of them. */
export const ASSETS: Asset[] = SECTORS.flatMap((sector) => [...build(sector, ROWS[sector], true), ...build(sector, EXTRA_ROWS[sector], false)]);

/** The house competition's listing, and a custom room's unless its host picks otherwise. */
export const CORE_TICKERS = ASSETS.filter((a) => a.core).map((a) => a.ticker);
