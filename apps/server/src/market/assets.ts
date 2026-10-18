// Real company identities, simulated prices. base is the opening price in euro cents and bears no
// relation to the real share price; the game never shows live quotes.

export const SECTORS = [
  'Technology',
  'Semiconductors',
  'Healthcare',
  'Finance',
  'Energy',
  'Automotive',
  'Consumer',
  'Industrials',
] as const;
export type Sector = (typeof SECTORS)[number];

/** Macro factors events can push. An asset's sensitivity scales a factor event's impact (negative = moves the other way). */
export const FACTORS = ['rates', 'oil', 'chips', 'consumer'] as const;
export type Factor = (typeof FACTORS)[number];

export interface Asset {
  ticker: string;
  name: string;
  sector: Sector;
  description: string;
  base: number;
  /** Idiosyncratic per-tick standard deviation of the log return. */
  vol: number;
  /** Exposure to the market-wide factor. */
  beta: number;
  sens: Partial<Record<Factor, number>>;
}

const SECTOR_SENS: Record<Sector, Partial<Record<Factor, number>>> = {
  Technology: { rates: 1, chips: 0.3, consumer: 0.3 },
  Semiconductors: { rates: 0.8, chips: -0.8 },
  Healthcare: { rates: 0.3, consumer: 0.1 },
  Finance: { rates: -0.8, consumer: 0.4 },
  Energy: { oil: 1, rates: 0.2 },
  Automotive: { chips: 1, oil: -0.4, consumer: 0.8, rates: 0.5 },
  Consumer: { consumer: 1, oil: -0.3, rates: 0.3 },
  Industrials: { oil: -0.5, chips: 0.4, consumer: 0.4, rates: 0.4 },
};

type Row = [ticker: string, name: string, base: number, vol: number, beta: number, description: string, sens?: Partial<Record<Factor, number>>];

const ROWS: Record<Sector, Row[]> = {
  Technology: [
    ['AAPL', 'Apple', 18_420, 0.0032, 1.0, 'Phones, computers and the services stacked on top of them.'],
    ['MSFT', 'Microsoft', 31_250, 0.0028, 0.95, 'Cloud infrastructure, office software and a gaming arm.'],
    ['GOOGL', 'Alphabet', 14_680, 0.0034, 1.05, 'Search, advertising, video and cloud computing.'],
    ['META', 'Meta Platforms', 27_390, 0.0042, 1.2, 'Social networks funded by advertising, plus headset bets.'],
    ['SAP', 'SAP', 16_840, 0.003, 0.9, 'Enterprise software that runs payroll, supply chains and ledgers.'],
  ],
  Semiconductors: [
    ['NVDA', 'Nvidia', 9_870, 0.0055, 1.4, 'Graphics and AI accelerator chips.'],
    ['ASML', 'ASML Holding', 41_200, 0.0042, 1.2, 'Lithography machines every advanced chip fab depends on.'],
    ['TSM', 'TSMC', 12_150, 0.0038, 1.15, 'Contract manufacturer for most of the world\'s leading-edge chips.'],
    ['AMD', 'AMD', 8_430, 0.0052, 1.35, 'Processors and graphics chips for PCs, consoles and data centres.'],
    ['INTC', 'Intel', 2_270, 0.0048, 1.1, 'PC and server processors, rebuilding its own foundry business.'],
  ],
  Healthcare: [
    ['NVO', 'Novo Nordisk', 7_960, 0.0036, 0.7, 'Diabetes and obesity treatments.'],
    ['PFE', 'Pfizer', 2_640, 0.003, 0.6, 'Vaccines and a broad pharmaceutical pipeline.'],
    ['JNJ', 'Johnson & Johnson', 14_310, 0.0022, 0.55, 'Pharmaceuticals and medical devices.'],
    ['AZN', 'AstraZeneca', 12_780, 0.0028, 0.6, 'Oncology, cardiovascular and respiratory medicines.'],
    ['ROG', 'Roche', 26_150, 0.0024, 0.55, 'Cancer drugs and diagnostics.'],
  ],
  Finance: [
    ['JPM', 'JPMorgan Chase', 19_840, 0.0028, 1.05, 'Retail, commercial and investment banking.'],
    ['GS', 'Goldman Sachs', 38_760, 0.0034, 1.2, 'Investment banking, trading and asset management.'],
    ['HSBA', 'HSBC', 790, 0.0028, 0.95, 'Global bank with deep roots in Asia.'],
    ['BNP', 'BNP Paribas', 6_350, 0.003, 1.05, 'Eurozone banking and insurance group.'],
    ['V', 'Visa', 25_480, 0.0024, 0.9, 'Card payments network.', { rates: 0.2, consumer: 0.7 }],
  ],
  Energy: [
    ['XOM', 'ExxonMobil', 10_260, 0.003, 0.8, 'Oil and gas production, refining and chemicals.'],
    ['SHEL', 'Shell', 3_140, 0.0028, 0.8, 'Integrated oil, gas and LNG trading.'],
    ['TTE', 'TotalEnergies', 5_870, 0.0028, 0.8, 'Oil, gas and a growing power business.'],
    ['NEE', 'NextEra Energy', 6_920, 0.0026, 0.6, 'Regulated utility and the largest wind and solar operator.', { oil: -0.3, rates: 0.9 }],
    ['ORSTED', 'Orsted', 3_980, 0.0046, 0.9, 'Offshore wind farm developer.', { oil: -0.4, rates: 1.1 }],
  ],
  Automotive: [
    ['TSLA', 'Tesla', 21_650, 0.0062, 1.6, 'Electric cars, batteries and charging.', { chips: 0.8, oil: -0.6, rates: 0.9, consumer: 0.8 }],
    ['VOW3', 'Volkswagen', 9_840, 0.0034, 1.05, 'Mass-market and luxury car brands from Wolfsburg.'],
    ['BMW', 'BMW', 8_710, 0.003, 1.0, 'Premium cars and motorcycles.'],
    ['TM', 'Toyota', 16_290, 0.0026, 0.85, 'The world\'s largest carmaker by volume, hybrids first.'],
    ['RACE', 'Ferrari', 38_940, 0.0028, 0.75, 'Sports cars built to a waiting list.', { chips: 0.4, consumer: 0.3 }],
  ],
  Consumer: [
    ['KO', 'Coca-Cola', 5_920, 0.0018, 0.5, 'Soft drinks bottled in nearly every country.', { consumer: 0.4 }],
    ['MC', 'LVMH', 64_350, 0.0032, 1.0, 'Luxury fashion, leather goods, wine and spirits.'],
    ['NESN', 'Nestle', 8_960, 0.0018, 0.5, 'Packaged food, coffee and pet care.', { consumer: 0.4 }],
    ['AMZN', 'Amazon', 16_380, 0.0036, 1.15, 'Online retail and the largest cloud platform.', { consumer: 0.9, rates: 0.8 }],
    ['NKE', 'Nike', 7_120, 0.0034, 0.9, 'Sportswear and sneakers.'],
  ],
  Industrials: [
    ['AIR', 'Airbus', 15_430, 0.0032, 1.05, 'Commercial aircraft, helicopters and defence.', { oil: -0.7 }],
    ['SIE', 'Siemens', 17_260, 0.0026, 0.95, 'Factory automation, rail and smart infrastructure.'],
    ['BA', 'Boeing', 17_840, 0.0046, 1.15, 'Commercial jets and defence systems.', { oil: -0.7 }],
    ['CAT', 'Caterpillar', 29_870, 0.003, 1.05, 'Construction and mining machinery.', { oil: 0.3 }],
    ['DHL', 'DHL Group', 3_960, 0.0028, 0.9, 'Express parcels, freight and logistics.', { oil: -0.6, consumer: 0.6 }],
  ],
};

export const ASSETS: Asset[] = SECTORS.flatMap((sector) =>
  ROWS[sector].map(([ticker, name, base, vol, beta, description, sens]) => ({
    ticker,
    name,
    sector,
    description,
    base,
    vol,
    beta,
    sens: { ...SECTOR_SENS[sector], ...sens },
  })),
);
