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

export const ASSETS: Asset[] = SECTORS.flatMap((sector) =>
  ROWS[sector].map(([ticker, name, exchange, industry, base, vol, beta, revenueBn, margin, growth, mult, description, sens]) => ({
    ticker, name, exchange, sector, industry, description, base, vol, beta, revenueBn, margin, growth, mult,
    sens: { ...SECTOR_SENS[sector], ...sens },
  })),
);
